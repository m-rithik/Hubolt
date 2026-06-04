import { z } from "zod";

export const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingCategorySchema = z.enum([
  "quality",
  "security",
  "performance",
  "bestPractice",
  "architecture",
  "refactor",
  "test",
  "documentation"
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const ReviewRangeSchema = z
  .object({
    file: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startColumn: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
    diffSide: z.enum(["left", "right"]).default("right"),
    githubPosition: z.number().int().positive().optional()
  })
  .refine((range) => range.endLine >= range.startLine, {
    message: "endLine must be greater than or equal to startLine"
  });
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;

export const FindingSchema = z.object({
  id: z.string().optional(),
  fingerprint: z.string().min(1),
  ruleId: z.string().min(1),
  title: z.string().min(1),
  message: z.string().min(1),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  confidenceLabel: z.enum(["low", "medium", "high"]),
  source: z.enum(["llm", "analyzer", "hybrid", "rule"]),
  range: ReviewRangeSchema,
  evidence: z.array(z.string().min(1)).min(1),
  impact: z.string().min(1),
  suggestion: z.string().optional(),
  verification: z.string().min(1),
  fixPatch: z.string().optional(),
  relatedSignals: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});
export type Finding = z.infer<typeof FindingSchema>;

/** Tag applied to findings whose range falls outside the changed line ranges. */
export const CONTEXT_ADJACENT_TAG = "context-adjacent";

/**
 * The subset of a finding the LLM produces. Kept strict-structured-output
 * friendly for OpenAI: every field is required, with no optionals, defaults,
 * or value constraints (those keywords are unsupported in strict mode). The
 * pipeline assigns identity (fingerprint, source) and maps this onto the rich
 * Finding/ReviewRange shape.
 */
export const LLMRangeSchema = z.object({
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int()
});
export type LLMRange = z.infer<typeof LLMRangeSchema>;

export const LLMFindingSchema = z.object({
  ruleId: z.string(),
  title: z.string(),
  message: z.string(),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  confidenceLabel: z.enum(["low", "medium", "high"]),
  range: LLMRangeSchema,
  evidence: z.array(z.string()),
  impact: z.string(),
  suggestion: z.string(),
  verification: z.string()
});
export type LLMFinding = z.infer<typeof LLMFindingSchema>;
