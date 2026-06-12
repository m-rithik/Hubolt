import { z } from "zod";
import { ReviewModeSchema } from "../config/schema.js";
import { RepoConfigSchema } from "../config/schema.js";
import { AnalyzerSignalSchema, FindingSchema, SeveritySchema } from "./finding.js";

const SeverityCountsSchema = z.object({
  info: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative()
});

const ReportCountsSchema = z.object({
  rawCount: z.number().int().nonnegative(),
  droppedInvalid: z.number().int().nonnegative(),
  droppedOutOfScope: z.number().int().nonnegative(),
  belowThreshold: z.number().int().nonnegative(),
  droppedByMode: z.number().int().nonnegative(),
  analyzerSignals: z.number().int().nonnegative(),
  promotedFromAnalyzers: z.number().int().nonnegative()
});

/**
 * Durable review artifact. Stable and schema-valid so it can be written to disk,
 * re-rendered, and consumed by automation. `report --from` re-validates it.
 */
export const ReviewReportSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.object({ name: z.string(), version: z.string(), promptVersion: z.string() }),
  generatedAt: z.string(),
  scope: z.string(),
  mode: ReviewModeSchema,
  provider: z.string(),
  model: z.string(),
  status: z.enum(["ok", "blocked"]),
  summary: z.object({ total: z.number().int().nonnegative(), bySeverity: SeverityCountsSchema }),
  counts: ReportCountsSchema,
  findings: z.array(FindingSchema),
  analyzerSignals: z.array(AnalyzerSignalSchema),
  config: RepoConfigSchema,
  // Optional and additive: reports written before token tracking existed
  // still validate, and providers that report no usage omit it.
  modelUsage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      estimatedCostUsd: z.number().nonnegative()
    })
    .optional()
});

export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type SeverityCounts = z.infer<typeof SeverityCountsSchema>;

/** Parse and validate an external report document (untrusted input). */
export function parseReport(json: string, source: string): ReviewReport {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid report JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ReviewReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid report ${source}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export const EMPTY_SEVERITY_COUNTS: SeverityCounts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
