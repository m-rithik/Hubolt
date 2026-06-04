import { z } from "zod";
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER_ID } from "../providers/llm/catalog.js";
import { SeveritySchema } from "../types/finding.js";

export const ReviewModeSchema = z.enum(["quiet", "balanced", "strict", "security"]);

const RepoConfigShape = {
  mode: ReviewModeSchema.default("balanced"),
  severityThreshold: SeveritySchema.default("medium"),
  failOnSeverity: SeveritySchema.default("critical"),
  commentBudget: z.number().int().positive().default(8),
  maxFileSizeKb: z.number().int().positive().default(256),
  maxContextTokens: z.number().int().positive().default(60000),
  providers: z
    .object({
      llm: z.string().min(1).default(DEFAULT_LLM_PROVIDER_ID),
      model: z.string().min(1).default(DEFAULT_LLM_MODEL)
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
};

export const REPO_CONFIG_TOP_LEVEL_KEYS = Object.freeze(Object.keys(RepoConfigShape));

export const RepoConfigSchema = z.object(RepoConfigShape);

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
