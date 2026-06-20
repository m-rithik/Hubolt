import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { hashApiKey } from "../api-keys.js";
import { shouldTouchLastUsed } from "../middleware/auth.js";
import { BudgetService } from "../services/budget.js";
import { z } from "zod";

const IngestLineRangeSchema = z
  .object({
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive()
  })
  .refine((range) => range.lineStart <= range.lineEnd, {
    message: "lineStart must be less than or equal to lineEnd",
    path: ["lineEnd"]
  });

// z.string().url() accepts javascript:, data:, and ftp: URLs. Repository URLs
// are stored and later rendered as links in the control panel, so restrict them
// to http(s) at the ingestion boundary.
const HttpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Repository URL must use http or https" }
  );

const IngestPayloadSchema = z.object({
  apiKey: z.string().min(1),
  repository: z.object({
    name: z.string(),
    fullName: z.string(),
    url: HttpUrlSchema
  }),
  review: z.object({
    fingerprint: z.string(),
    scope: z.string(),
    provider: z.string(),
    model: z.string(),
    summary: z.string().optional(),
    findingCount: z.number().int().min(0)
  }),
  findings: z.array(
    z.object({
      ruleId: z.string(),
      message: z.string(),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      category: z.string().max(40).optional(),
      file: z.string(),
      fingerprint: z.string(),
      confidence: z.number().min(0).max(1).default(0.5)
    }).and(IngestLineRangeSchema)
  ),
  analyzerSignals: z.array(
    z.object({
      analyzer: z.string(),
      ruleId: z.string(),
      message: z.string(),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      file: z.string()
    }).and(IngestLineRangeSchema)
  ).optional(),
  modelUsage: z.object({
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    estimatedCostUsd: z.number().min(0).default(0)
  }).optional()
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/** Keep the first finding per fingerprint; later duplicates are dropped. */
function dedupeByFingerprint<T extends { fingerprint: string }>(findings: T[]): T[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) {
      return false;
    }
    seen.add(finding.fingerprint);
    return true;
  });
}

export interface IngestResponse {
  success: boolean;
  reviewId: string;
  message: string;
}

export function registerIngestRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const budgetService = new BudgetService(context.db);

  fastify.post<{ Body: IngestPayload; Reply: IngestResponse }>(
    "/ingest/review",
    async (request, reply) => {
      let reservedUsage: { orgId: string; provider: string; model: string; costUsd: number } | null = null;

      try {
        const payload = IngestPayloadSchema.parse(request.body);

        const apiKey = await context.db.apiKey.findUnique({
          where: { keyHash: hashApiKey(payload.apiKey) },
          include: { org: true }
        });

        if (!apiKey || !apiKey.org) {
          reply.status(401).send({
            success: false,
            reviewId: "",
            message: "Invalid API key"
          });
          return;
        }

        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
          reply.status(401).send({
            success: false,
            reviewId: "",
            message: "API key expired"
          });
          return;
        }

        // Ingest writes reviews/findings and reserves provider budget. The
        // read-only viewer role must not do either; keys created before roles
        // existed default to admin so their access is unchanged.
        if (((apiKey as { role?: string }).role ?? "admin") !== "admin") {
          reply.status(403).send({
            success: false,
            reviewId: "",
            message: "This API key is read-only"
          });
          return;
        }

        const provider = payload.modelUsage?.provider || payload.review.provider;
        const model = payload.modelUsage?.model || payload.review.model;
        const estimatedCost = payload.modelUsage?.estimatedCostUsd || 0;

        // Findings are unique per (review, fingerprint) in the database; a
        // payload repeating a fingerprint must not fail the whole ingest.
        const findings = dedupeByFingerprint(payload.findings);

        const repo = await context.db.repository.upsert({
          where: { orgId_fullName: { orgId: apiKey.orgId, fullName: payload.repository.fullName } },
          create: {
            orgId: apiKey.orgId,
            name: payload.repository.name,
            fullName: payload.repository.fullName,
            url: payload.repository.url
          },
          update: {
            name: payload.repository.name,
            url: payload.repository.url
          }
        });

        const existingReview = await context.db.review.findUnique({
          where: { repoId_fingerprint: { repoId: repo.id, fingerprint: payload.review.fingerprint } },
          select: { id: true }
        });

        if (!existingReview) {
          const reservation = await budgetService.reserveUsage(
            apiKey.orgId,
            provider,
            model,
            estimatedCost
          );

          if (!reservation.allowed) {
            reply.status(reservation.statusCode ?? 429).send({
              success: false,
              reviewId: "",
              message: reservation.reason ?? "Usage limit exceeded"
            });
            return;
          }

          reservedUsage = { orgId: apiKey.orgId, provider, model, costUsd: estimatedCost };
        }

        // Write the review and its child rows atomically. Without the
        // transaction a mid-sequence failure could leave a review whose
        // findings were deleted but never re-created.
        const review = await context.db.$transaction(async (tx) => {
          const upserted = await tx.review.upsert({
            where: { repoId_fingerprint: { repoId: repo.id, fingerprint: payload.review.fingerprint } },
            create: {
              orgId: apiKey.orgId,
              repoId: repo.id,
              fingerprint: payload.review.fingerprint,
              scope: payload.review.scope,
              provider: payload.review.provider,
              model: payload.review.model,
              summary: payload.review.summary,
              findingCount: findings.length
            },
            update: {
              orgId: apiKey.orgId,
              scope: payload.review.scope,
              provider: payload.review.provider,
              model: payload.review.model,
              summary: payload.review.summary,
              findingCount: findings.length
            }
          });

          await tx.finding.deleteMany({
            where: { reviewId: upserted.id }
          });

          await tx.analyzerSignal.deleteMany({
            where: { reviewId: upserted.id }
          });

          await tx.modelUsage.deleteMany({
            where: { reviewId: upserted.id }
          });

          if (findings.length > 0) {
            await tx.finding.createMany({
              data: findings.map((f) => ({
                orgId: apiKey.orgId,
                repoId: repo.id,
                reviewId: upserted.id,
                ruleId: f.ruleId,
                message: f.message,
                severity: f.severity,
                category: f.category ?? null,
                file: f.file,
                lineStart: f.lineStart,
                lineEnd: f.lineEnd,
                fingerprint: f.fingerprint,
                confidence: f.confidence
              }))
            });
          }

          if (payload.analyzerSignals && payload.analyzerSignals.length > 0) {
            await tx.analyzerSignal.createMany({
              data: payload.analyzerSignals.map((s) => ({
                reviewId: upserted.id,
                analyzer: s.analyzer,
                ruleId: s.ruleId,
                message: s.message,
                severity: s.severity,
                file: s.file,
                lineStart: s.lineStart,
                lineEnd: s.lineEnd
              }))
            });
          }

          if (payload.modelUsage) {
            await tx.modelUsage.create({
              data: {
                reviewId: upserted.id,
                provider: payload.modelUsage.provider,
                model: payload.modelUsage.model,
                inputTokens: payload.modelUsage.inputTokens,
                outputTokens: payload.modelUsage.outputTokens,
                estimatedCostUsd: payload.modelUsage.estimatedCostUsd
              }
            });
          }

          return upserted;
        });

        // The review is durable past this point. Bookkeeping failures are
        // logged but must not fail the request or trigger a refund, since the
        // ingested review exists and its cost was genuinely consumed.
        try {
          if (shouldTouchLastUsed(apiKey.lastUsedAt)) {
            await context.db.apiKey.update({
              where: { id: apiKey.id },
              data: { lastUsedAt: new Date() }
            });
          }

          await context.db.auditEvent.create({
            data: {
              orgId: apiKey.orgId,
              action: "review.ingested",
              resource: "review",
              resourceId: review.id,
              details: JSON.stringify({
                repo: payload.repository.fullName,
                findings: findings.length,
                cost: estimatedCost
              })
            }
          });
        } catch (bookkeepingError) {
          fastify.log.error(bookkeepingError);
        }

        reply.status(201).send({
          success: true,
          reviewId: review.id,
          message: `Review ingested with ${findings.length} finding(s)`
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            success: false,
            reviewId: "",
            message: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`
          });
          return;
        }

        fastify.log.error(error);
        if (reservedUsage) {
          // reserveUsage increments both the monthly budget (when cost > 0) and
          // the daily rate-limit window; a failure after reservation must
          // release both, or the slot stays burned for work that never ran.
          try {
            await budgetService.refundUsage(reservedUsage.orgId, reservedUsage.provider, reservedUsage.costUsd);
            await budgetService.refundRateLimit(reservedUsage.orgId, reservedUsage.provider, reservedUsage.model);
          } catch (refundError) {
            fastify.log.error(refundError);
          }
        }

        reply.status(500).send({
          success: false,
          reviewId: "",
          message: "Failed to ingest review"
        });
      }
    }
  );
}
