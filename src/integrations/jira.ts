import type { IssueDraft, IssueResult, IssueTarget } from "./issues.js";

export interface JiraTargetOptions {
  baseUrl?: string;
  projectKey?: string;
  email?: string;
  apiToken?: string;
  issueType?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Create issues in Jira Cloud via the REST v2 endpoint (plain-text
 * description). Auth is HTTP Basic with email + API token. Missing config
 * yields a failed IssueResult rather than throwing.
 */
/**
 * The Jira base receives an HTTP Basic credential (email + API token), so it
 * must be HTTPS and carry no embedded userinfo. Reject anything else so a
 * misconfigured or hostile destination cannot exfiltrate the token. Returns the
 * trimmed base without a trailing slash, or "" when the URL is untrusted.
 */
function toTrustedHttpsBase(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

export function createJiraTarget(options: JiraTargetOptions): IssueTarget {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = toTrustedHttpsBase(options.baseUrl);
  const ready = Boolean(base && options.projectKey && options.email && options.apiToken);

  return {
    name: "jira",
    available() {
      return ready;
    },
    async createIssue(draft: IssueDraft): Promise<IssueResult> {
      if (!ready) {
        return { target: "jira", ok: false, error: "missing Jira config (baseUrl, projectKey, email, token)" };
      }

      const auth = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
      const payload = {
        fields: {
          project: { key: options.projectKey },
          summary: draft.title.slice(0, 255),
          description: draft.body,
          issuetype: { name: options.issueType ?? "Task" },
          // Jira labels cannot contain spaces; guard non-string entries too.
          labels: draft.labels
            .filter((label): label is string => typeof label === "string" && label.length > 0)
            .map((label) => label.replace(/\s+/g, "-"))
        }
      };

      try {
        const response = await fetchImpl(`${base}/rest/api/2/issue`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          return { target: "jira", ok: false, error: `Jira responded ${response.status}` };
        }
        const data = (await response.json().catch(() => ({}))) as { key?: string };
        return {
          target: "jira",
          ok: true,
          key: data.key,
          url: data.key ? `${base}/browse/${data.key}` : undefined
        };
      } catch (error) {
        return { target: "jira", ok: false, error: error instanceof Error ? error.message : "request failed" };
      }
    }
  };
}
