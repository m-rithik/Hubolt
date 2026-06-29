import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, isAdmin } from "../middleware/auth.js";
import { readableRepoIds } from "../services/repository-access.js";
import { z } from "zod";

const ListReviewsQuerySchema = z.object({
  repo: z.string().optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(["created", "findings"]).default("created"),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
});

const BooleanQuerySchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  return value;
}, z.boolean());

const GetReviewQuerySchema = z.object({
  includeFindings: BooleanQuerySchema.default(true),
  includeSignals: BooleanQuerySchema.default(true)
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

  fastify.get(
    "/history/trends",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const { days: daysRaw } = request.query as { days?: string };
        const days = Math.min(Math.max(Number.parseInt(daysRaw ?? "30", 10) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86400000);
        // Developers see trends only for repos they were granted.
        const trendIds = await readableRepoIds(context.db, request.orgId!, request.userId, isAdmin(request));
        const orgScope: { orgId: string; createdAt: { gte: Date }; repoId?: { in: string[] } } = {
          orgId: request.orgId!,
          createdAt: { gte: since },
          ...(trendIds ? { repoId: { in: trendIds } } : {})
        };
        const feedbackScope: { orgId: string; createdAt: { gte: Date }; repoId?: { in: string[] } } = {
          orgId: request.orgId!,
          createdAt: { gte: since },
          ...(trendIds ? { repoId: { in: trendIds } } : {})
        };

        const [reviewCount, severityRows, categoryGroups, categoryRows, verdictRows, ruleRows] = await Promise.all([
          context.db.review.count({
            where: orgScope
          }),
          context.db.finding.groupBy({
            by: ["severity"],
            where: orgScope,
            _count: { _all: true }
          }),
          context.db.finding.groupBy({
            by: ["category"],
            where: orgScope,
            _count: { _all: true },
            orderBy: { _count: { category: "desc" } },
            take: 10
          }),
          context.db.finding.groupBy({
            by: ["ruleId"],
            where: orgScope,
            _count: { _all: true },
            orderBy: { _count: { ruleId: "desc" } },
            take: 10
          }),
          context.db.findingFeedback.groupBy({
            by: ["verdict"],
            where: feedbackScope,
            _count: { _all: true }
          }),
          context.db.findingFeedback.groupBy({
            by: ["ruleId", "verdict"],
            where: feedbackScope,
            _count: { _all: true }
          })
        ]);

        const bySeverity: Record<string, number> = {};
        for (const row of severityRows) bySeverity[row.severity] = row._count._all;

        const feedback: Record<string, number> = { accepted: 0, dismissed: 0, discussed: 0 };
        for (const row of verdictRows) feedback[row.verdict] = row._count._all;

        const resolved = feedback.accepted + feedback.dismissed;
        const acceptanceRate = resolved > 0 ? feedback.accepted / resolved : null;

        const ruleFeedback = new Map<string, { accepted: number; dismissed: number }>();
        for (const row of ruleRows) {
          const entry = ruleFeedback.get(row.ruleId) ?? { accepted: 0, dismissed: 0 };
          if (row.verdict === "accepted") entry.accepted += row._count._all;
          if (row.verdict === "dismissed") entry.dismissed += row._count._all;
          ruleFeedback.set(row.ruleId, entry);
        }

        reply.send({
          days,
          reviews: reviewCount,
          findings: {
            total: Object.values(bySeverity).reduce((sum, n) => sum + n, 0),
            bySeverity
          },
          feedback: { ...feedback, acceptanceRate },
          topCategories: categoryGroups
            .filter((row) => row.category)
            .map((row) => ({ category: row.category as string, findings: row._count._all })),
          topRules: categoryRows.map((row) => {
            const fb = ruleFeedback.get(row.ruleId) ?? { accepted: 0, dismissed: 0 };
            const total = fb.accepted + fb.dismissed;
            return {
              ruleId: row.ruleId,
              findings: row._count._all,
              accepted: fb.accepted,
              dismissed: fb.dismissed,
              acceptanceRate: total > 0 ? fb.accepted / total : null
            };
          })
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to compute trends" });
      }
    }
  );

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
          orgId: request.orgId
        };

        // Developers may only read reviews for repositories they were granted.
        const readableIds = await readableRepoIds(context.db, request.orgId!, request.userId, isAdmin(request));
        if (readableIds) {
          where.repoId = { in: readableIds };
        }

        if (query.repo) {
          where.repo = { fullName: { contains: query.repo, mode: "insensitive" } };
        }
        if (query.severity) {
          where.findings = { some: { severity: query.severity } };
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

        // Scope the lookup by org in the query itself so callers from another
        // org receive the same 404 whether or not the review exists. Checking
        // ownership after the fetch would leak review IDs across orgs.
        const readableIds = await readableRepoIds(context.db, request.orgId!, request.userId, isAdmin(request));
        const review = await context.db.review.findFirst({
          where: {
            id,
            orgId: request.orgId,
            // Developers get a 404 for reviews outside their granted repos.
            ...(readableIds ? { repoId: { in: readableIds } } : {})
          },
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
