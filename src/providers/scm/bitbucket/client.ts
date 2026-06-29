import type {
  InlineCommentDraft,
  IssueComment,
  PullRequestFile,
  PullRequestInfo,
  ReviewComment,
  ScmProvider
} from "../scm.interface.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

export class BitbucketScmError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "BitbucketScmError";
  }
}

export interface BitbucketClientOptions {
  /** "workspace/repo" slug. */
  repoFullName: string;
  /** Bitbucket Repository or Workspace Access Token (Bearer). */
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RawComment {
  id: number;
  content?: { raw?: string };
  inline?: { path?: string; from?: number | null; to?: number | null };
  deleted?: boolean;
  user?: { nickname?: string; display_name?: string };
}

/**
 * Bitbucket Cloud adapter for the SCM boundary. Maps the shared ScmProvider
 * contract onto Bitbucket's REST API (v2.0). Key differences from GitHub it
 * absorbs: there is no atomic "review" object (inline comments are posted one
 * by one), inline comments are single-line, and the diff arrives as one raw
 * unified-diff body that this client splits per file into GitHub-style patches.
 */
export class BitbucketScmProvider implements ScmProvider {
  private repo: string;
  private token: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  // Bitbucket's comment-update endpoint needs the PR id in its path, but the
  // interface's updateIssueComment only gets the comment id. Every call that
  // carries a PR number records it here; post.ts always lists comments for a PR
  // before updating one, so this is populated in time.
  private currentPr?: number;

  constructor(options: BitbucketClientOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repoFullName)) {
      throw new Error(`Invalid repository slug: ${options.repoFullName} (expected workspace/repo)`);
    }
    if (!options.token) {
      throw new Error("A Bitbucket access token is required");
    }
    this.repo = options.repoFullName;
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPullRequest(prNumber: number): Promise<PullRequestInfo> {
    this.currentPr = prNumber;
    const raw = await this.requestJson<{
      id: number;
      draft?: boolean;
      source: { commit: { hash: string } };
      destination: { commit: { hash: string }; branch: { name: string } };
    }>("GET", `/repositories/${this.repo}/pullrequests/${prNumber}`);

    return {
      number: raw.id,
      headSha: raw.source.commit.hash,
      baseSha: raw.destination.commit.hash,
      baseRef: raw.destination.branch.name,
      draft: Boolean(raw.draft)
      // Bitbucket does not report a mergeability verdict here; leave it absent.
    };
  }

  async listPullRequestFiles(prNumber: number): Promise<PullRequestFile[]> {
    this.currentPr = prNumber;
    const url = `${this.baseUrl}/repositories/${this.repo}/pullrequests/${prNumber}/diff`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) {
      throw await this.toError(response, `fetch diff for PR ${prNumber}`);
    }
    return parseUnifiedDiff(await response.text());
  }

  async compareCommits(baseSha: string, headSha: string): Promise<string[] | null> {
    // Bitbucket diff spec is "source..destination"; here source is the newer
    // head and destination the older base, so this lists what head changed.
    const spec = `${encodeURIComponent(headSha)}..${encodeURIComponent(baseSha)}`;
    try {
      const rows = await this.getPaginated<{ new?: { path?: string }; old?: { path?: string } }>(
        `${this.baseUrl}/repositories/${this.repo}/diffstat/${spec}?pagelen=${PAGE_SIZE}`
      );
      const paths = rows.map((row) => row.new?.path ?? row.old?.path).filter((p): p is string => Boolean(p));
      return paths;
    } catch {
      // Force push or missing commit: fall back to a full review.
      return null;
    }
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${this.baseUrl}/repositories/${this.repo}/src/${encodeURIComponent(ref)}/${encodedPath}`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.toError(response, `fetch content of ${path}`);
    }
    return await response.text();
  }

  async listIssueComments(prNumber: number): Promise<IssueComment[]> {
    this.currentPr = prNumber;
    const raw = await this.getPaginated<RawComment>(
      `${this.baseUrl}/repositories/${this.repo}/pullrequests/${prNumber}/comments?pagelen=${PAGE_SIZE}`
    );
    return raw
      .filter((comment) => !comment.deleted && !comment.inline)
      .map((comment) => ({ id: comment.id, body: comment.content?.raw ?? "" }));
  }

  async createIssueComment(prNumber: number, body: string): Promise<IssueComment> {
    this.currentPr = prNumber;
    const created = await this.requestJson<RawComment>(
      "POST",
      `/repositories/${this.repo}/pullrequests/${prNumber}/comments`,
      { content: { raw: body } }
    );
    return { id: created.id, body: created.content?.raw ?? "" };
  }

  async updateIssueComment(commentId: number, body: string): Promise<void> {
    if (this.currentPr === undefined) {
      throw new BitbucketScmError("Cannot update a comment without a known pull request", 400);
    }
    await this.requestJson(
      "PUT",
      `/repositories/${this.repo}/pullrequests/${this.currentPr}/comments/${commentId}`,
      { content: { raw: body } }
    );
  }

  async listReviewComments(prNumber: number): Promise<ReviewComment[]> {
    this.currentPr = prNumber;
    const raw = await this.getPaginated<RawComment>(
      `${this.baseUrl}/repositories/${this.repo}/pullrequests/${prNumber}/comments?pagelen=${PAGE_SIZE}`
    );
    return raw
      .filter((comment) => !comment.deleted && comment.inline)
      .map((comment) => ({
        id: comment.id,
        body: comment.content?.raw ?? "",
        path: comment.inline?.path ?? "",
        line: comment.inline?.to ?? comment.inline?.from ?? null,
        authorLogin: comment.user?.nickname ?? comment.user?.display_name,
        // Bitbucket does not flag bot authors or expose reactions on comments.
        authorIsBot: false,
        reactions: { up: 0, down: 0 }
      }));
  }

  async createReview(
    prNumber: number,
    _commitSha: string,
    body: string | undefined,
    comments: InlineCommentDraft[]
  ): Promise<void> {
    this.currentPr = prNumber;

    // Bitbucket has no atomic review; post a general comment (if any) then each
    // inline comment individually. Best-effort per comment so one rejected line
    // (e.g. not in the current diff) does not drop the rest.
    if (body) {
      await this.createIssueComment(prNumber, body);
    }

    let firstError: unknown;
    for (const comment of comments) {
      const inline =
        comment.side === "LEFT"
          ? { path: comment.path, from: comment.line }
          : { path: comment.path, to: comment.line };
      try {
        await this.requestJson("POST", `/repositories/${this.repo}/pullrequests/${prNumber}/comments`, {
          content: { raw: comment.body },
          inline
        });
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError && comments.length === 1) {
      throw firstError;
    }
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "hubolt"
    };
  }

  private async requestJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

    if (!response.ok) {
      throw await this.toError(response, `${method} ${path}`);
    }

    // Some endpoints (PUT/POST) may return an empty body; tolerate that.
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async getPaginated<T>(firstUrl: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = firstUrl;

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response: Response = await this.fetchImpl(url, { headers: this.headers() });
      if (!response.ok) {
        throw await this.toError(response, `GET ${url}`);
      }
      const body = (await response.json()) as { values?: T[]; next?: string };
      if (Array.isArray(body.values)) {
        results.push(...body.values);
      }
      url = body.next ?? null;
    }

    if (url) {
      throw new BitbucketScmError(`Bitbucket pagination exceeded ${MAX_PAGES} pages while fetching ${firstUrl}`, 502);
    }

    return results;
  }

  /**
   * Build an error without echoing response bodies verbatim: Bitbucket error
   * bodies are controlled input and the message must never carry credentials.
   */
  private async toError(response: Response, action: string): Promise<BitbucketScmError> {
    let detail = "";
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      const message = parsed?.error?.message;
      if (typeof message === "string") {
        detail = `: ${message.slice(0, 200)}`;
      }
    } catch {
      // Body unavailable or not JSON; the status is enough.
    }
    return new BitbucketScmError(
      `Bitbucket request failed (${response.status}) while trying to ${action}${detail}`,
      response.status
    );
  }
}

const FILE_STATUS_FROM_HEADER: Array<[string, PullRequestFile["status"]]> = [
  ["new file mode", "added"],
  ["deleted file mode", "removed"]
];

/**
 * Split a git unified diff into per-file entries with GitHub-style patches.
 * buildFileDiffIndex only reads lines from the first "@@" hunk header onward,
 * so keeping the full per-file section (headers included) as the patch is safe.
 */
export function parseUnifiedDiff(diff: string): PullRequestFile[] {
  if (!diff.trim()) {
    return [];
  }

  const files: PullRequestFile[] = [];
  // Split at each file header; the delimiter is re-added so the patch is intact.
  const sections = diff.split(/^diff --git /m).slice(1);

  for (const section of sections) {
    const patch = "diff --git " + section;
    const lines = section.split("\n");

    let status: PullRequestFile["status"] = "modified";
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let previousFilename: string | undefined;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        break;
      }
      for (const [prefix, mapped] of FILE_STATUS_FROM_HEADER) {
        if (line.startsWith(prefix)) {
          status = mapped;
        }
      }
      if (line.startsWith("rename from ")) {
        status = "renamed";
        previousFilename = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        newPath = line.slice("rename to ".length).trim();
      } else if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") oldPath = stripDiffPrefix(p);
      } else if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") newPath = stripDiffPrefix(p);
      }
    }

    const filename = newPath ?? oldPath ?? stripDiffPrefix(lines[0]?.split(" ")[0] ?? "");
    files.push({
      filename,
      status,
      patch,
      ...(previousFilename ? { previousFilename } : {})
    });
  }

  return files;
}

function stripDiffPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}
