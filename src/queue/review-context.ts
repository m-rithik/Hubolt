import picomatch from "picomatch";
import { estimateTokensFromBytes, type BuiltContext, type ReviewFile } from "../core/context-builder.js";
import type { ChangeStatus } from "../core/git.js";
import type { PullRequestFile } from "../providers/scm/scm.interface.js";
import { changedRangesFromPatch } from "../github/line-mapping.js";

export interface BuildHostedContextParams {
  files: PullRequestFile[];
  /** Raw file content at the PR head, or null when unavailable. */
  fetchContent: (path: string) => Promise<string | null>;
  ignoreGlobs: string[];
  maxFileSizeKb: number;
  /** Total context budget across all files (config.maxContextTokens). */
  maxContextTokens: number;
  /** When set, only these paths are reviewed (incremental synchronize runs). */
  onlyPaths?: Set<string>;
  scope: string;
}

const STATUS_MAP: Record<PullRequestFile["status"], ChangeStatus> = {
  added: "added",
  modified: "modified",
  removed: "deleted",
  renamed: "renamed",
  copied: "added",
  changed: "modified",
  unchanged: "modified"
};

const CONTENT_FETCH_CONCURRENCY = 5;

/**
 * Build the pipeline's BuiltContext from pull request files fetched over the
 * SCM API instead of a local checkout. Mirrors the local context builder's
 * rules: deleted and ignored files are skipped, oversized files are marked
 * too-large rather than loaded, unfetchable files are marked unreadable.
 * File contents are fetched with bounded parallelism; one request per file
 * in sequence would dominate job latency on larger pull requests.
 */
export async function buildHostedContext(params: BuildHostedContextParams): Promise<BuiltContext> {
  const isIgnored = params.ignoreGlobs.length > 0
    ? picomatch(params.ignoreGlobs, { dot: true })
    : () => false;
  const maxBytes = params.maxFileSizeKb * 1024;

  // First pass: classify every file without I/O. Entries that survive
  // classification get their content fetched in the second pass.
  const classified: Array<ReviewFile | null> = params.files.map((file) => {
    const status = STATUS_MAP[file.status];
    const changedRanges = file.patch ? changedRangesFromPatch(file.patch) : [];
    const base: ReviewFile = { path: file.filename, status, changedRanges };

    if (params.onlyPaths && !params.onlyPaths.has(file.filename)) {
      return null;
    }

    if (status === "deleted") {
      return { ...base, skipped: "deleted" };
    }

    if (isIgnored(file.filename)) {
      return { ...base, skipped: "ignored" };
    }

    if (!file.patch) {
      // Binary or too large for the API to produce a patch; nothing to review.
      return { ...base, skipped: "too-large" };
    }

    return base;
  });

  const fetchTargets = classified.filter(
    (entry): entry is ReviewFile => entry !== null && entry.skipped === undefined
  );

  await mapWithConcurrency(fetchTargets, CONTENT_FETCH_CONCURRENCY, async (entry) => {
    let content: string | null;
    try {
      content = await params.fetchContent(entry.path);
    } catch {
      content = null;
    }

    if (content === null) {
      entry.skipped = "unreadable";
    } else if (Buffer.byteLength(content, "utf8") > maxBytes) {
      entry.skipped = "too-large";
    } else {
      entry.content = content;
    }
  });

  const files = classified.filter((entry): entry is ReviewFile => entry !== null);

  // Enforce the total context budget greedily in change order. Contents were
  // fetched in parallel above, so the cut happens after the fact; a few
  // wasted fetches on enormous PRs beat serializing every fetch.
  let remainingTokens = params.maxContextTokens;
  for (const file of files) {
    if (file.skipped || file.content === undefined) continue;
    const tokens = estimateTokensFromBytes(Buffer.byteLength(file.content, "utf8"));
    if (tokens > remainingTokens) {
      file.skipped = "over-budget";
      delete file.content;
      continue;
    }
    remainingTokens -= tokens;
  }

  return {
    scope: params.scope,
    files,
    reviewable: files.filter((file) => !file.skipped && file.content !== undefined)
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}
