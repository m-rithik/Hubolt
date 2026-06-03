import dotenv from "dotenv";

export interface HuboltEnv {
  llmProvider?: string;
  llmModel?: string;
  reviewConcurrency?: number;
  cacheDir?: string;
}

export function loadEnv(envFile?: string): HuboltEnv {
  dotenv.config(envFile ? { path: envFile } : undefined);

  return {
    llmProvider: process.env.HUBOLT_LLM_PROVIDER,
    llmModel: process.env.HUBOLT_LLM_MODEL,
    reviewConcurrency: parsePositiveInt(process.env.HUBOLT_REVIEW_CONCURRENCY),
    cacheDir: process.env.HUBOLT_CACHE_DIR
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
