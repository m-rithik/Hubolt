import type { RepoConfig } from "../config/schema.js";
import { SLACK_WEBHOOK_ENV, TEAMS_WEBHOOK_ENV } from "./env-names.js";
import { createSlackAdapter } from "./slack.js";
import { createTeamsAdapter } from "./teams.js";
import type { DeliveryResult, IntegrationAdapter, IntegrationEvent } from "./types.js";

export interface BuildIntegrationsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Build the adapters a repo has enabled. Disabled integrations are omitted, so
 * an empty result means "no integrations configured" and the caller does
 * nothing. Secrets are resolved from the environment here, never from config.
 */
export function buildIntegrations(config: RepoConfig, deps: BuildIntegrationsDeps = {}): IntegrationAdapter[] {
  const env = deps.env ?? process.env;
  const adapters: IntegrationAdapter[] = [];

  const slack = config.integrations.slack;
  if (slack.enabled) {
    adapters.push(
      createSlackAdapter({
        webhookUrl: env[SLACK_WEBHOOK_ENV]?.trim() || undefined,
        minSeverity: slack.minSeverity,
        fetchImpl: deps.fetchImpl
      })
    );
  }

  const teams = config.integrations.teams;
  if (teams.enabled) {
    adapters.push(
      createTeamsAdapter({
        webhookUrl: env[TEAMS_WEBHOOK_ENV]?.trim() || undefined,
        minSeverity: teams.minSeverity,
        fetchImpl: deps.fetchImpl
      })
    );
  }

  return adapters;
}

/**
 * Deliver one event to every adapter. Best-effort by contract: a failing
 * adapter yields a failed DeliveryResult rather than throwing, so one broken
 * integration never blocks the others or the review that triggered them.
 */
export async function dispatchIntegrations(
  event: IntegrationEvent,
  adapters: IntegrationAdapter[]
): Promise<DeliveryResult[]> {
  return Promise.all(
    adapters.map((adapter) =>
      adapter.deliver(event).catch(
        (error): DeliveryResult => ({
          adapter: adapter.name,
          ok: false,
          error: error instanceof Error ? error.message : "delivery failed",
          redacted: true
        })
      )
    )
  );
}
