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

export const ReviewRangeSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startColumn: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
  diffSide: z.enum(["left", "right"]).default("right"),
  githubPosition: z.number().int().positive().optional()
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
