export interface ProviderInfo {
  id: string;
  label: string;
  apiKeyEnv: string;
  defaultModel: string;
}

export const DEFAULT_LLM_PROVIDER_ID = "openai";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_LLM_MODEL = DEFAULT_OPENAI_MODEL;

/**
 * Single source of truth for selectable LLM providers: their display label,
 * the environment variable holding their API key, and a sensible default model.
 * Used by interactive setup and by `config validate`'s credential check.
 */
export const PROVIDERS: ProviderInfo[] = [
  { id: DEFAULT_LLM_PROVIDER_ID, label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", defaultModel: DEFAULT_OPENAI_MODEL },
  {
    id: "claude",
    label: "Claude (Anthropic)",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5-20251001"
  },
  {
    id: "google",
    label: "Google (Gemini)",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaultModel: "gemini-flash-latest"
  }
];

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
