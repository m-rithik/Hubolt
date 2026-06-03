import { z } from "zod";
import { SeveritySchema } from "../types/finding.js";

export const ReviewModeSchema = z.enum(["quiet", "balanced", "strict", "security"]);

export const RepoConfigSchema = z.object({
  mode: ReviewModeSchema.default("balanced"),
  severityThreshold: SeveritySchema.default("medium"),
  failOnSeverity: SeveritySchema.default("critical"),
  commentBudget: z.number().int().positive().default(8),
  maxFileSizeKb: z.number().int().positive().default(256),
  maxContextTokens: z.number().int().positive().default(60000),
  providers: z
    .object({
      llm: z.string().min(1).default("openai"),
      model: z.string().min(1).default("gpt-4.1-mini")
    })
    .default({}),
  privacy: z
    .object({
      redactSecrets: z.boolean().default(true),
      showContextSentToModel: z.boolean().default(true),
      allowExternalModels: z.boolean().default(true)
    })
    .default({}),
  security: z
    .object({
      enabled: z.boolean().default(false),
      failOnSeverity: SeveritySchema.default("high"),
      includeSecretScan: z.boolean().default(true),
      includeDependencyAudit: z.boolean().default(true),
      includeSemgrepSecurityRules: z.boolean().default(true),
      includeAuthAndInputValidationChecks: z.boolean().default(true),
      commentBudget: z.number().int().positive().default(12),
      lowConfidenceToSummaryOnly: z.boolean().default(true)
    })
    .default({}),
  analyzers: z
    .object({
      typescript: z.boolean().default(true),
      eslint: z.boolean().default(true),
      semgrep: z.boolean().default(true),
      secrets: z.boolean().default(true),
      dependencies: z.boolean().default(true)
    })
    .default({}),
  ignore: z.array(z.string()).default([]),
  knowledgeFiles: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([])
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
