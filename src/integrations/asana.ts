import type { IssueDraft, IssueResult, IssueTarget } from "./issues.js";

export interface AsanaTargetOptions {
  projectGid?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Create tasks in an Asana project. Auth is a Bearer personal access token.
 * Missing config yields a failed IssueResult.
 */
export function createAsanaTarget(options: AsanaTargetOptions): IssueTarget {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ready = Boolean(options.projectGid && options.apiToken);

  return {
    name: "asana",
    available() {
      return ready;
    },
    async createIssue(draft: IssueDraft): Promise<IssueResult> {
      if (!ready) {
        return { target: "asana", ok: false, error: "missing Asana config (projectGid, token)" };
      }

      try {
        const response = await fetchImpl("https://app.asana.com/api/1.0/tasks", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiToken}` },
          body: JSON.stringify({ data: { name: draft.title, notes: draft.body, projects: [options.projectGid] } })
        });
        if (!response.ok) {
          return { target: "asana", ok: false, error: `Asana responded ${response.status}` };
        }
        const data = (await response.json().catch(() => ({}))) as { data?: { gid?: string; permalink_url?: string } };
        return { target: "asana", ok: true, key: data.data?.gid, url: data.data?.permalink_url };
      } catch (error) {
        return { target: "asana", ok: false, error: error instanceof Error ? error.message : "request failed" };
      }
    }
  };
}
