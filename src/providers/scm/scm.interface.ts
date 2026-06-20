/**
 * SCM provider boundary for hosted review posting. Core modules (line
 * mapping, comment building, the worker) depend only on this interface;
 * GitHub specifics live in the adapter.
 */

export type PullRequestFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PullRequestFile {
  filename: string;
  status: PullRequestFileStatus;
  /** Unified diff hunks for this file. Absent for binary or very large files. */
  patch?: string;
  previousFilename?: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  /** Comment id this one replies to, when it is a thread reply. */
  inReplyTo?: number | null;
  authorLogin?: string;
  authorIsBot?: boolean;
  /** Author's association with the repo (e.g. OWNER, MEMBER, CONTRIBUTOR). */
  authorRole?: string;
  /** Reaction rollup as delivered by the SCM (thumbs up / down). */
  reactions?: { up: number; down: number };
}

export type DiffSide = "LEFT" | "RIGHT";

export interface InlineCommentDraft {
  path: string;
  body: string;
  /** End line of the comment range, in file coordinates for the given side. */
  line: number;
  side: DiffSide;
  /** Present only for multi-line comments; must be < line. */
  startLine?: number;
  startSide?: DiffSide;
}

export interface PullRequestInfo {
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  draft: boolean;
  /**
   * GitHub's mergeability verdict. `false` means the PR has conflicts with its
   * base; `null` means GitHub has not finished computing it yet. Absent when the
   * SCM does not report it.
   */
  mergeable?: boolean | null;
  /** Raw mergeable_state (e.g. "clean", "dirty", "blocked", "behind"). */
  mergeableState?: string;
}

export interface ScmProvider {
  getPullRequest(prNumber: number): Promise<PullRequestInfo>;
  listPullRequestFiles(prNumber: number): Promise<PullRequestFile[]>;
  /**
   * File paths changed between two commits, or null when the comparison is
   * not possible (for example after a force push). Callers must treat null
   * as "fall back to a full review".
   */
  compareCommits(baseSha: string, headSha: string): Promise<string[] | null>;
  /** Raw file content at a ref, or null when the file does not exist there. */
  getFileContent(path: string, ref: string): Promise<string | null>;
  listIssueComments(prNumber: number): Promise<IssueComment[]>;
  createIssueComment(prNumber: number, body: string): Promise<IssueComment>;
  updateIssueComment(commentId: number, body: string): Promise<void>;
  listReviewComments(prNumber: number): Promise<ReviewComment[]>;
  /**
   * Post a review with inline comments in one atomic call. An empty comments
   * array with a body posts a review-level comment only.
   */
  createReview(
    prNumber: number,
    commitSha: string,
    body: string | undefined,
    comments: InlineCommentDraft[]
  ): Promise<void>;
}
