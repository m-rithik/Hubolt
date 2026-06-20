import type { RepoConfig } from "../config/schema.js";
import { createAsanaTarget } from "./asana.js";
import { createClickUpTarget } from "./clickup.js";
import {
  ASANA_TOKEN_ENV,
  CLICKUP_TOKEN_ENV,
  JIRA_BASE_URL_ENV,
  JIRA_EMAIL_ENV,
  JIRA_TOKEN_ENV
} from "./env-names.js";
import { createJiraTarget } from "./jira.js";
import type { IssueDraft, IssueResult, IssueTarget } from "./issues.js";

export interface BuildIssueTargetsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Build the issue-tracker targets a repo has enabled. Repo config only toggles
 * an integration and supplies non-secret routing (project key, issue type). The
 * destination and credentials (Jira base URL + email + token) come from the
 * environment, never from the untrusted repo config.
 */
export function buildIssueTargets(config: RepoConfig, deps: BuildIssueTargetsDeps = {}): IssueTarget[] {
  const env = deps.env ?? process.env;
  const targets: IssueTarget[] = [];

  const jira = config.integrations.jira;
  if (jira.enabled) {
    targets.push(
      createJiraTarget({
        baseUrl: env[JIRA_BASE_URL_ENV]?.trim() || undefined,
        projectKey: jira.projectKey,
        email: env[JIRA_EMAIL_ENV]?.trim() || undefined,
        issueType: jira.issueType,
        apiToken: env[JIRA_TOKEN_ENV]?.trim() || undefined,
        fetchImpl: deps.fetchImpl
      })
    );
  }

  const clickup = config.integrations.clickup;
  if (clickup.enabled) {
    targets.push(
      createClickUpTarget({
        listId: clickup.listId,
        apiToken: env[CLICKUP_TOKEN_ENV]?.trim() || undefined,
        fetchImpl: deps.fetchImpl
      })
    );
  }

  const asana = config.integrations.asana;
  if (asana.enabled) {
    targets.push(
      createAsanaTarget({
        projectGid: asana.projectGid,
        apiToken: env[ASANA_TOKEN_ENV]?.trim() || undefined,
        fetchImpl: deps.fetchImpl
      })
    );
  }

  return targets;
}

/**
 * Create every draft in one target, sequentially to stay under provider rate
 * limits. Best-effort: a failed create becomes a failed IssueResult, never a
 * thrown error, so one bad finding does not abort the batch.
 */
export async function createIssuesIn(target: IssueTarget, drafts: IssueDraft[]): Promise<IssueResult[]> {
  const results: IssueResult[] = [];
  for (const draft of drafts) {
    try {
      results.push(await target.createIssue(draft));
    } catch (error) {
      results.push({ target: target.name, ok: false, error: error instanceof Error ? error.message : "create failed" });
    }
  }
  return results;
}
