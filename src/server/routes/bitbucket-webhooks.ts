import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { verifyGitHubSignature } from "../webhooks/signature.js";
import { classifyBitbucketEvent } from "../webhooks/bitbucket-payload.js";
import { runBitbucketReview } from "../services/bitbucket-review.js";
import { getActiveBitbucketWebhookSecret, isBitbucketConfigured } from "../services/bitbucket-config.js";

interface WebhookResponse {
  processed: boolean;
  reason?: string;
  prNumber?: number;
  repository?: string;
}

/**
 * Bitbucket webhook ingest. Verifies the signature, recognizes pull request
 * events, and runs a full review in the background (diff fetch, LLM review,
 * persistence, and posting a summary plus inline comments via the
 * BitbucketScmProvider). The webhook is acknowledged immediately so it does not
 * time out while the review runs.
 *
 * Registered inside an encapsulated plugin so the raw-buffer parser (needed to
 * verify the signature over the exact delivered bytes) does not leak into the
 * rest of the server.
 */
export function registerBitbucketWebhookRoutes(fastify: FastifyInstance, context: ServerContext): void {
  fastify.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );

    instance.post("/webhooks/bitbucket", async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        reply.status(400).send({ processed: false, reason: "missing request body" } satisfies WebhookResponse);
        return;
      }

      // The webhook secret is resolved per request from stored config (set in
      // the dashboard) or the environment, so the dashboard can change it
      // without a restart. Bitbucket Cloud signs with the same HMAC-SHA256
      // "sha256=" scheme as GitHub; the header is X-Hub-Signature (no -256).
      const secret = await getActiveBitbucketWebhookSecret(context.db);
      if (secret) {
        const sig = request.headers["x-hub-signature"];
        const signature = typeof sig === "string" ? sig : undefined;
        if (!verifyGitHubSignature(secret, rawBody, signature)) {
          reply.status(401).send({ processed: false, reason: "invalid signature" } satisfies WebhookResponse);
          return;
        }
      } else {
        // ponytail: secret optional so the trigger can be tested locally; set a
        // webhook secret (dashboard or env) to enforce verification.
        request.log.warn("Bitbucket webhook received without a configured secret; signature not verified");
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        reply.status(400).send({ processed: false, reason: "payload is not valid JSON" } satisfies WebhookResponse);
        return;
      }

      const eventHeader = request.headers["x-event-key"];
      const eventKey = typeof eventHeader === "string" ? eventHeader : undefined;
      const classification = classifyBitbucketEvent(eventKey, body);

      if (classification.kind === "invalid") {
        reply.status(400).send({ processed: false, reason: classification.reason } satisfies WebhookResponse);
        return;
      }

      if (classification.kind === "ignored") {
        request.log.info({ event: eventKey }, "Bitbucket webhook ignored");
        reply.status(202).send({ processed: false, reason: classification.reason } satisfies WebhookResponse);
        return;
      }

      const event = classification.event;
      request.log.info(
        {
          event: eventKey,
          repository: event.repository.full_name,
          prNumber: event.pullrequest.id,
          headSha: event.pullrequest.source.commit.hash,
          baseSha: event.pullrequest.destination.commit.hash
        },
        "Bitbucket webhook TRIGGERED: pull request received"
      );

      // Run the full review in the background and acknowledge immediately so the
      // webhook does not time out. The pipeline fetches the diff, runs the LLM
      // review, persists it, and posts a summary plus inline comments. A
      // duplicate delivery for an already-reviewed head is skipped inside the
      // pipeline via the persisted pull request state.
      if (await isBitbucketConfigured(context.db)) {
        void runBitbucketReview(context.db, {
          repoFullName: event.repository.full_name,
          repoName: event.repository.name,
          prNumber: event.pullrequest.id,
          action: eventKey ?? "pullrequest"
        })
          .then((outcome) => {
            request.log.info(
              { prNumber: event.pullrequest.id, status: outcome.status },
              "Bitbucket review finished"
            );
          })
          .catch((error) => {
            request.log.error({ err: error, prNumber: event.pullrequest.id }, "Bitbucket review failed");
          });
      } else {
        request.log.warn("Bitbucket API not configured (BITBUCKET_API_TOKEN); skipping review");
      }

      reply.status(202).send({
        processed: true,
        prNumber: event.pullrequest.id,
        repository: event.repository.full_name
      } satisfies WebhookResponse);
    });
  });
}
