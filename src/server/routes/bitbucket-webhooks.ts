import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { verifyGitHubSignature } from "../webhooks/signature.js";
import { classifyBitbucketEvent } from "../webhooks/bitbucket-payload.js";
import { runBitbucketReview } from "../services/bitbucket-review.js";
import { findIntegrationsByRepoFullName } from "../services/repository-integrations.js";

interface WebhookResponse {
  processed: boolean;
  reason?: string;
  prNumber?: number;
  repository?: string;
}

/**
 * Bitbucket webhook ingest. The body is parsed first to learn which repository
 * the delivery is for, then that repository's named integration supplies the
 * webhook secret used to verify the signature and the API token used to post
 * the review. Parsing before verifying is safe: the parsed value only selects
 * which secret to check, and nothing acts on the payload until the signature is
 * validated. The review runs in the background so the webhook returns quickly.
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
      const repoFullName = event.repository.full_name;

      // Resolve the tenant by VERIFYING the signature against each integration
      // registered for this repo full name (across all orgs). The matching
      // secret identifies the owning org - never organization.findFirst().
      const candidates = await findIntegrationsByRepoFullName(context.db, repoFullName);
      if (candidates.length === 0) {
        request.log.warn({ repository: repoFullName }, "No integration configured for repository; skipping");
        reply
          .status(202)
          .send({ processed: false, reason: "no integration configured for this repository" } satisfies WebhookResponse);
        return;
      }

      const sig = request.headers["x-hub-signature"];
      const signature = typeof sig === "string" ? sig : undefined;
      const matches = candidates.filter(
        (c) => c.webhookSecret && verifyGitHubSignature(c.webhookSecret, rawBody, signature)
      );
      if (matches.length === 0) {
        reply
          .status(401)
          .send({ processed: false, reason: "invalid or unverifiable signature" } satisfies WebhookResponse);
        return;
      }
      if (matches.length > 1) {
        request.log.warn({ repository: repoFullName }, "multiple integrations match this delivery; refusing");
        reply.status(409).send({ processed: false, reason: "ambiguous integration match" } satisfies WebhookResponse);
        return;
      }
      const integration = matches[0];

      request.log.info(
        { event: eventKey, repository: repoFullName, prNumber: event.pullrequest.id, orgId: integration.orgId },
        "Bitbucket webhook TRIGGERED: pull request received"
      );

      // Run the review in the background; a duplicate delivery for an already
      // reviewed head is skipped inside the pipeline via the persisted state.
      void runBitbucketReview(context.db, {
        orgId: integration.orgId,
        repoId: integration.repoId,
        repoFullName,
        prNumber: event.pullrequest.id,
        action: eventKey ?? "pullrequest",
        token: integration.token,
        slackWebhookUrl: integration.slackWebhookUrl
      })
        .then((outcome) => {
          request.log.info({ prNumber: event.pullrequest.id, status: outcome.status }, "Bitbucket review finished");
        })
        .catch((error) => {
          request.log.error({ err: error, prNumber: event.pullrequest.id }, "Bitbucket review failed");
        });

      reply.status(202).send({
        processed: true,
        prNumber: event.pullrequest.id,
        repository: repoFullName
      } satisfies WebhookResponse);
    });
  });
}
