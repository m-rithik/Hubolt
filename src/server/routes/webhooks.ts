import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { verifyGitHubSignature } from "../webhooks/signature.js";
import { classifyWebhookEvent, classifyInstallationEvent, type InstallationChange } from "../webhooks/payload.js";
import { ReviewJobProducer } from "../../queue/review-jobs.js";

export interface WebhookRouteOptions {
  /** Any configured signing secret; a delivery is accepted if it matches one. */
  secrets: string[];
  producer: ReviewJobProducer;
}

interface WebhookResponse {
  processed: boolean;
  reason?: string;
  jobId?: string;
  queued?: boolean;
}

/**
 * GitHub webhook ingest. Registered inside an encapsulated plugin so the
 * raw-buffer content type parser (required for signature verification over
 * the exact delivered bytes) does not leak into the rest of the server.
 *
 * Response policy: 401 for bad signatures, 400 for unparseable payloads,
 * 202 for everything else - including events we skip - so GitHub does not
 * mark deliveries as failed and retry them.
 */
export function registerWebhookRoutes(
  fastify: FastifyInstance,
  context: ServerContext,
  options: WebhookRouteOptions
): void {
  fastify.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );

    instance.post("/webhooks/github", async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        reply.status(400).send({ processed: false, reason: "missing request body" } satisfies WebhookResponse);
        return;
      }

      const signatureHeader = request.headers["x-hub-signature-256"];
      const signature = typeof signatureHeader === "string" ? signatureHeader : undefined;

      if (!options.secrets.some((secret) => verifyGitHubSignature(secret, rawBody, signature))) {
        reply.status(401).send({ processed: false, reason: "invalid signature" } satisfies WebhookResponse);
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        reply.status(400).send({ processed: false, reason: "payload is not valid JSON" } satisfies WebhookResponse);
        return;
      }

      const eventHeader = request.headers["x-github-event"];
      const eventName = typeof eventHeader === "string" ? eventHeader : undefined;

      // App install/uninstall events keep each registered repo's install status
      // current so the dashboard reflects reality before the first pull request.
      const installationChange = classifyInstallationEvent(eventName, body);
      if (installationChange) {
        try {
          await applyInstallationChange(context.db, installationChange);
        } catch (error) {
          request.log.warn({ err: error }, "failed to apply installation change");
        }
        reply.status(202).send({ processed: true, reason: "installation updated" } satisfies WebhookResponse);
        return;
      }

      const classification = classifyWebhookEvent(eventName, body);

      if (classification.kind === "invalid") {
        reply.status(400).send({ processed: false, reason: classification.reason } satisfies WebhookResponse);
        return;
      }

      if (classification.kind === "ignored") {
        reply.status(202).send({ processed: false, reason: classification.reason } satisfies WebhookResponse);
        return;
      }

      const event = classification.event;

      try {
        const repos = await context.db.repository.findMany({
          where: { fullName: event.repository.full_name, disabledAt: null },
          select: { id: true, orgId: true },
          take: 2
        });

        if (repos.length === 0) {
          reply.status(202).send({
            processed: false,
            reason: "repository is not registered with any organization"
          } satisfies WebhookResponse);
          return;
        }

        if (repos.length > 1) {
          request.log.warn(
            { repository: event.repository.full_name },
            "webhook repository is registered with multiple organizations; skipping"
          );
          reply.status(202).send({
            processed: false,
            reason: "repository registration is ambiguous"
          } satisfies WebhookResponse);
          return;
        }

        const repo = repos[0];
        const deliveryHeader = request.headers["x-github-delivery"];
        const installationId = event.installation ? String(event.installation.id) : undefined;

        // Remember which installation grants access to this repo so the
        // dashboard can show install status and the worker can mint a token.
        // Best-effort: a failed update must not block enqueueing the review.
        if (installationId) {
          try {
            await context.db.repository.update({
              where: { id: repo.id },
              data: { installationId }
            });
          } catch (error) {
            request.log.warn({ err: error, repoId: repo.id }, "failed to persist installation id");
          }
        }

        const { jobId, created } = await options.producer.enqueue({
          orgId: repo.orgId,
          repoId: repo.id,
          repoFullName: event.repository.full_name,
          prNumber: event.pull_request.number,
          headSha: event.pull_request.head.sha,
          baseSha: event.pull_request.base.sha,
          baseRef: event.pull_request.base.ref,
          action: event.action,
          deliveryId: typeof deliveryHeader === "string" ? deliveryHeader : undefined,
          installationId
        });

        reply.status(202).send({ processed: true, jobId, queued: created } satisfies WebhookResponse);
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ processed: false, reason: "failed to enqueue review job" } satisfies WebhookResponse);
      }
    });
  });
}

/**
 * Reflect an App install/uninstall onto registered repos. Matching is by full
 * name (the installation grants access regardless of which Hubolt org
 * registered the repo); unlinking is scoped to the same installation so a
 * removal cannot clear a repo wired to a different installation.
 */
async function applyInstallationChange(db: ServerContext["db"], change: InstallationChange): Promise<void> {
  if (change.linked.length > 0) {
    await db.repository.updateMany({
      where: { fullName: { in: change.linked } },
      data: { installationId: change.installationId }
    });
  }

  if (change.unlinked.length > 0) {
    await db.repository.updateMany({
      where: { fullName: { in: change.unlinked }, installationId: change.installationId },
      data: { installationId: null }
    });
  }
}
