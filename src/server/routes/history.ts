import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated } from "../middleware/auth.js";
import { z } from "zod";

const ListReviewsQuerySchema = z.object({
  repo: z.string().optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(["created", "findings"]).default("created"),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
});

const GetReviewQuerySchema = z.object({
  includeFindings: z.coerce.boolean().default(true),
  includeSignals: z.coerce.boolean().default(true)
});

interface ListReviewsResponse {
  reviews: Array<{
    id: string;
    repository: string;
    provider: string;
    model: string;
    findingCount: number;
    createdAt: string;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

interface GetReviewResponse {
  id: string;
  repository: string;
  scope: string;
  provider: string;
  model: string;
  summary: string | null;
  findingCount: number;
  createdAt: string;
  findings: Array<{
    id: string;
    ruleId: string;
    message: string;
    severity: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    confidence: number;
  }>;
  analyzerSignals: Array<{
    id: string;
    analyzer: string;
    ruleId: string;
    message: string;
    severity: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  }>;
  modelUsage: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }>;
}

export function registerHistoryRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get<{ Querystring: z.infer<typeof ListReviewsQuerySchema>; Reply: ListReviewsResponse }>(
    "/history/reviews",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const query = ListReviewsQuerySchema.parse(request.query);

        const where: any = {
          repo: {
            orgId: request.orgId
          }
        };

        if (query.repo) {
          where.repo.fullName = { contains: query.repo, mode: "insensitive" };
        }

        const total = await context.db.review.count({ where });

        const orderBy: any =
          query.sortBy === "findings"
            ? { findingCount: query.sortOrder }
            : { createdAt: query.sortOrder };

        const reviews = await context.db.review.findMany({
          where,
          include: {
            repo: true
          },
          orderBy,
          skip: query.offset,
          take: query.limit
        });

        const response: ListReviewsResponse = {
          reviews: reviews.map((r: any) => ({
            id: r.id,
            repository: r.repo.fullName,
            provider: r.provider,
            model: r.model,
            findingCount: r.findingCount,
            createdAt: r.createdAt.toISOString()
          })),
          pagination: {
            total,
            limit: query.limit,
            offset: query.offset
          }
        };

        reply.send(response);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid query parameters",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to list reviews" });
      }
    }
  );

  fastify.get<{
    Params: { id: string };
    Querystring: z.infer<typeof GetReviewQuerySchema>;
    Reply: GetReviewResponse;
  }>(
    "/history/reviews/:id",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const { id } = request.params as { id: string };
        const query = GetReviewQuerySchema.parse(request.query);

        const review = await context.db.review.findUnique({
          where: { id },
          include: {
            repo: true,
            findings: query.includeFindings,
            analyzerSignals: query.includeSignals,
            modelUsage: true
          }
        });

        if (!review) {
          reply.status(404).send({ error: "Review not found" });
          return;
        }

        const reviewData = review as any;

        if (reviewData.repo.orgId !== request.orgId) {
          reply.status(403).send({ error: "Forbidden" });
          return;
        }

        const response: GetReviewResponse = {
          id: reviewData.id,
          repository: reviewData.repo.fullName,
          scope: reviewData.scope,
          provider: reviewData.provider,
          model: reviewData.model,
          summary: reviewData.summary,
          findingCount: reviewData.findingCount,
          createdAt: reviewData.createdAt.toISOString(),
          findings: Array.isArray(reviewData.findings)
            ? reviewData.findings.map((f: any) => ({
                id: f.id,
                ruleId: f.ruleId,
                message: f.message,
                severity: f.severity,
                file: f.file,
                lineStart: f.lineStart,
                lineEnd: f.lineEnd,
                confidence: f.confidence
              }))
            : [],
          analyzerSignals: Array.isArray(reviewData.analyzerSignals)
            ? reviewData.analyzerSignals.map((s: any) => ({
                id: s.id,
                analyzer: s.analyzer,
                ruleId: s.ruleId,
                message: s.message,
                severity: s.severity,
                file: s.file,
                lineStart: s.lineStart,
                lineEnd: s.lineEnd
              }))
            : [],
          modelUsage: Array.isArray(reviewData.modelUsage)
            ? reviewData.modelUsage.map((m: any) => ({
                provider: m.provider,
                model: m.model,
                inputTokens: m.inputTokens,
                outputTokens: m.outputTokens,
                estimatedCostUsd: m.estimatedCostUsd
              }))
            : []
        };

        reply.send(response);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid query parameters",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to get review" });
      }
    }
  );
}
