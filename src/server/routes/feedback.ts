import { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated } from "../middleware/auth.js";
import { FeedbackService } from "../services/feedback.js";

const FeedbackEventSchema = z.object({
  fingerprint: z.string().min(1),
  verdict: z.enum(["accepted", "dismissed", "discussed"]),
  source: z.string().min(1).max(60),
  externalId: z.string().min(1).max(200).optional(),
  actor: z.string().max(120).optional(),
  role: z.string().max(40).optional(),
  note: z.string().max(2000).optional()
});

const IngestFeedbackSchema = z
  .object({
    repo: z.string().min(1).max(200).optional(),
    repoId: z.string().min(1).max(120).optional(),
    events: z.array(FeedbackEventSchema).min(1).max(500)
  })
  .refine((body) => Boolean(body.repo || body.repoId), {
    message: "repo or repoId is required",
    path: ["repo"]
  });

export function registerFeedbackRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);
  const feedbackService = new FeedbackService(context.db);

  fastify.post<{ Body: z.infer<typeof IngestFeedbackSchema> }>(
    "/feedback",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const body = IngestFeedbackSchema.parse(request.body);
        const repoId = await resolveFeedbackRepoId(context, request.orgId!, body);
        if (!repoId) {
          reply.status(404).send({ error: "Repository not found" });
          return;
        }
        const result = await feedbackService.ingest(request.orgId!, body.events, { repoId });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "feedback.ingested",
            resource: "feedback",
            details: JSON.stringify(result)
          }
        });

        reply.status(201).send({ success: true, ...result });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to ingest feedback" });
      }
    }
  );
}

async function resolveFeedbackRepoId(
  context: ServerContext,
  orgId: string,
  body: z.infer<typeof IngestFeedbackSchema>
): Promise<string | undefined> {
  if (body.repoId) {
    const repo = await context.db.repository.findFirst({
      where: { id: body.repoId, orgId },
      select: { id: true }
    });
    return repo?.id;
  }

  const repo = await context.db.repository.findFirst({
    where: { orgId, fullName: body.repo! },
    select: { id: true }
  });
  return repo?.id;
}
