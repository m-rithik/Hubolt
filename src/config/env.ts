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

/**
 * Env loading for server-side processes (server, worker, bootstrap): .env
 * first, then .env.local overriding it. Matches the dev entrypoint so
 * `hubolt server` and `npm run dev:server` see identical configuration.
 */
export function loadServerEnv(): void {
  dotenv.config();
  dotenv.config({ path: ".env.local", override: true });
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
