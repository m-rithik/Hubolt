import type { IssueDraft, IssueResult, IssueTarget } from "./issues.js";

export interface ClickUpTargetOptions {
  listId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Create tasks in a ClickUp list. Auth is the personal API token sent in the
 * Authorization header. Missing config yields a failed IssueResult.
 */
export function createClickUpTarget(options: ClickUpTargetOptions): IssueTarget {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ready = Boolean(options.listId && options.apiToken);

  return {
    name: "clickup",
    available() {
      return ready;
    },
    async createIssue(draft: IssueDraft): Promise<IssueResult> {
      if (!ready) {
        return { target: "clickup", ok: false, error: "missing ClickUp config (listId, token)" };
      }

      try {
        const response = await fetchImpl(
          `https://api.clickup.com/api/v2/list/${encodeURIComponent(options.listId!)}/task`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: options.apiToken! },
            body: JSON.stringify({ name: draft.title, description: draft.body, tags: draft.labels })
          }
        );
        if (!response.ok) {
          return { target: "clickup", ok: false, error: `ClickUp responded ${response.status}` };
        }
        const data = (await response.json().catch(() => ({}))) as { id?: string; url?: string };
        return { target: "clickup", ok: true, key: data.id, url: data.url };
      } catch (error) {
        return { target: "clickup", ok: false, error: error instanceof Error ? error.message : "request failed" };
      }
    }
  };
}
