import type {
  InlineCommentDraft,
  IssueComment,
  PullRequestFile,
  PullRequestInfo,
  ReviewComment,
  ScmProvider
} from "../scm.interface.js";

const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const COMPARE_FILES_LIMIT = 300;

export class ScmError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "ScmError";
  }
}

export interface GitHubClientOptions {
  /** "owner/name" repository slug. */
  repoFullName: string;
  token: string;
  /** Override for GitHub Enterprise; defaults to https://api.github.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RawPullRequestFile {
  filename: string;
  status: PullRequestFile["status"];
  patch?: string;
  previous_filename?: string;
}

interface RawComment {
  id: number;
  body?: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number | null;
  user?: { login?: string; type?: string };
  reactions?: Record<string, unknown>;
}

export class GitHubScmProvider implements ScmProvider {
  private repo: string;
  private token: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repoFullName)) {
      throw new Error(`Invalid repository slug: ${options.repoFullName} (expected owner/name)`);
    }
    if (!options.token) {
      throw new Error("A GitHub token is required");
    }

    this.repo = options.repoFullName;
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPullRequest(prNumber: number): Promise<PullRequestInfo> {
    const raw = await this.requestJson<{
      number: number;
      draft?: boolean;
      head: { sha: string };
      base: { sha: string; ref: string };
    }>("GET", `/repos/${this.repo}/pulls/${prNumber}`);

    return {
      number: raw.number,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      baseRef: raw.base.ref,
      draft: raw.draft ?? false
    };
  }

  async listPullRequestFiles(prNumber: number): Promise<PullRequestFile[]> {
    const raw = await this.getPaginated<RawPullRequestFile>(`/repos/${this.repo}/pulls/${prNumber}/files`);
    return raw.map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: file.patch,
      previousFilename: file.previous_filename
    }));
  }

  async compareCommits(baseSha: string, headSha: string): Promise<string[] | null> {
    const base = encodeURIComponent(baseSha);
    const head = encodeURIComponent(headSha);
    const url = `${this.baseUrl}/repos/${this.repo}/compare/${base}...${head}?per_page=${PAGE_SIZE}`;
    const response = await this.fetchImpl(url, { headers: this.headers(JSON_ACCEPT) });

    // 404 means one of the commits is gone (force push); the caller falls
    // back to a full review rather than failing the job.
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.toError(response, `compare ${baseSha}...${headSha}`);
    }

    const body = (await response.json()) as { files?: Array<{ filename: string }> };
    if (!Array.isArray(body.files)) {
      return null;
    }

    // The compare API caps the file listing (300 files) and does not
    // paginate it. At or past the cap the list may be incomplete, and an
    // incomplete list would silently exclude changed files from incremental
    // review - fall back to a full review instead.
    if (body.files.length >= COMPARE_FILES_LIMIT) {
      return null;
    }

    return body.files.map((file) => file.filename);
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${this.baseUrl}/repos/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const response = await this.fetchImpl(url, {
      headers: this.headers(RAW_ACCEPT)
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.toError(response, `fetch content of ${path}`);
    }

    return await response.text();
  }

  async listIssueComments(prNumber: number): Promise<IssueComment[]> {
    const raw = await this.getPaginated<RawComment>(`/repos/${this.repo}/issues/${prNumber}/comments`);
    return raw.map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
  }

  async createIssueComment(prNumber: number, body: string): Promise<IssueComment> {
    const created = await this.requestJson<RawComment>(
      "POST",
      `/repos/${this.repo}/issues/${prNumber}/comments`,
      { body }
    );
    return { id: created.id, body: created.body ?? "" };
  }

  async updateIssueComment(commentId: number, body: string): Promise<void> {
    await this.requestJson("PATCH", `/repos/${this.repo}/issues/comments/${commentId}`, { body });
  }

  async listReviewComments(prNumber: number): Promise<ReviewComment[]> {
    const raw = await this.getPaginated<RawComment>(`/repos/${this.repo}/pulls/${prNumber}/comments`);
    return raw.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      path: comment.path ?? "",
      line: comment.line ?? null,
      inReplyTo: comment.in_reply_to_id ?? null,
      authorLogin: comment.user?.login,
      authorIsBot: comment.user?.type === "Bot",
      reactions: {
        up: readReactionCount(comment.reactions, "+1"),
        down: readReactionCount(comment.reactions, "-1")
      }
    }));
  }

  async createReview(
    prNumber: number,
    commitSha: string,
    body: string | undefined,
    comments: InlineCommentDraft[]
  ): Promise<void> {
    await this.requestJson("POST", `/repos/${this.repo}/pulls/${prNumber}/reviews`, {
      commit_id: commitSha,
      event: "COMMENT",
      body: body ?? "",
      comments: comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side: comment.side,
        ...(comment.startLine !== undefined
          ? { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }
          : {})
      }))
    });
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.token}`,
      "user-agent": "hubolt",
      "x-github-api-version": API_VERSION
    };
  }

  private async requestJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(JSON_ACCEPT),
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

    if (!response.ok) {
      throw await this.toError(response, `${method} ${path}`);
    }

    return (await response.json()) as T;
  }

  private async getPaginated<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${this.baseUrl}${path}?per_page=${PAGE_SIZE}`;

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response: Response = await this.fetchImpl(url, { headers: this.headers(JSON_ACCEPT) });
      if (!response.ok) {
        throw await this.toError(response, `GET ${path}`);
      }

      const items = (await response.json()) as T[];
      if (!Array.isArray(items)) {
        throw new ScmError(`Unexpected non-array response for GET ${path}`, 502);
      }
      results.push(...items);

      url = parseNextLink(response.headers.get("link"));
    }

    if (url) {
      throw new ScmError(`GitHub pagination exceeded ${MAX_PAGES} pages for GET ${path}`, 502);
    }

    return results;
  }

  /**
   * Build an error from an API response without including response bodies
   * verbatim: GitHub error bodies are controlled input but can be large, and
   * the message must never carry credentials.
   */
  private async toError(response: Response, action: string): Promise<ScmError> {
    let detail = "";
    try {
      const parsed = (await response.json()) as { message?: string };
      if (parsed && typeof parsed.message === "string") {
        detail = `: ${parsed.message.slice(0, 200)}`;
      }
    } catch {
      // Body unavailable or not JSON; the status is enough.
    }

    return new ScmError(`GitHub request failed (${response.status}) while trying to ${action}${detail}`, response.status);
  }
}

function readReactionCount(reactions: Record<string, unknown> | undefined, key: string): number {
  const value = reactions?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extract the rel="next" URL from a Link header, if present. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }

  return null;
}
