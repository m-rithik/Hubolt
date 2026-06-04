import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER_ID } from "../providers/llm/catalog.js";

export function renderStarterConfig(): string {
  return [
    "mode: balanced",
    "severityThreshold: medium",
    "failOnSeverity: critical",
    "commentBudget: 8",
    "maxFileSizeKb: 256",
    "maxContextTokens: 60000",
    "",
    "providers:",
    `  llm: ${DEFAULT_LLM_PROVIDER_ID}`,
    `  model: ${DEFAULT_LLM_MODEL}`,
    "",
    "privacy:",
    "  redactSecrets: true",
    "  showContextSentToModel: true",
    "  allowExternalModels: true",
    "",
    "rules: []",
    ""
  ].join("\n");
}
