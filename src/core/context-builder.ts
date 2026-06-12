import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import type { RepoConfig } from "../config/schema.js";
import { parseUnifiedDiff, type ChangedRange } from "./diff.js";
import { getChangedFiles, getDiffText, gitFileContent, gitFileSize, type ChangeStatus, type ChangedFilesOptions } from "./git.js";
import { mapChangedRegions, type SemanticRegion } from "./semantic-map.js";

export type SkipReason = "deleted" | "ignored" | "too-large" | "unreadable" | "over-budget";

/**
 * Matches the gateway's estimator: ~4 bytes of source per token. Used to
 * enforce config.maxContextTokens across the whole context, not per file.
 */
const BYTES_PER_TOKEN = 4;

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export interface ReviewFile {
  path: string;
  status: ChangeStatus;
  changedRanges: ChangedRange[];
  content?: string;
  regions?: SemanticRegion[];
  skipped?: SkipReason;
}

export interface BuiltContext {
  scope: string;
  files: ReviewFile[];
  reviewable: ReviewFile[];
}

export interface BuildContextOptions extends ChangedFilesOptions {
  config: RepoConfig;
}

export function describeScope(options: ChangedFilesOptions): string {
  if (options.base && options.head) {
    return `${options.base}..${options.head}`;
  }

  return options.staged ? "staged changes" : "working tree";
}

export async function buildContext(options: BuildContextOptions): Promise<BuiltContext> {
  const cwd = options.cwd ?? process.cwd();
  const { config } = options;

  const changed = getChangedFiles(options);

  // getDiffText can fail for edge cases such as a tracked file being replaced
  // with a FIFO or socket in the working tree. Treat failure as no diff ranges
  // available — files are still reviewed, just without fine-grained line info.
  const rangesByPath = new Map<string, ChangedRange[]>();
  try {
    for (const fileDiff of parseUnifiedDiff(getDiffText(options))) {
      rangesByPath.set(fileDiff.path, fileDiff.changedRanges);
    }
  } catch {
    // Degraded mode: review changed files without line-range highlighting.
  }

  const isIgnored = config.ignore.length > 0 ? picomatch(config.ignore, { dot: true }) : () => false;
  const maxBytes = config.maxFileSizeKb * 1024;

  // Total context budget. Greedy first-fit in change order: a file that does
  // not fit is skipped, but smaller files after it may still use the
  // remaining budget. Without this cap a many-file change ships the model an
  // unbounded prompt (and an unbounded bill).
  let remainingTokens = config.maxContextTokens;

  const files: ReviewFile[] = [];
  for (const file of changed) {
    const changedRanges = rangesByPath.get(file.path) ?? [];

    if (file.status === "deleted") {
      files.push({ path: file.path, status: file.status, changedRanges, skipped: "deleted" });
      continue;
    }

    if (isIgnored(file.path)) {
      files.push({ path: file.path, status: file.status, changedRanges, skipped: "ignored" });
      continue;
    }

    const absolute = resolve(cwd, file.path);
    try {
      // Size-check before loading to avoid buffering huge files.
      // git mode: cat-file -s returns byte count without transferring content.
      // working-tree: statSync reads inode metadata only.
      // Both are fast; the content load only happens when size is within limit.
      const gitSize = gitFileSize(file.path, options);
      if (gitSize !== null) {
        if (gitSize > maxBytes) {
          files.push({ path: file.path, status: file.status, changedRanges, skipped: "too-large" });
          continue;
        }
        if (estimateTokensFromBytes(gitSize) > remainingTokens) {
          files.push({ path: file.path, status: file.status, changedRanges, skipped: "over-budget" });
          continue;
        }
      } else {
        try {
          const stat = statSync(absolute);
          if (!stat.isFile()) {
            // Skip FIFOs, sockets, devices — readFileSync blocks on them indefinitely.
            files.push({ path: file.path, status: file.status, changedRanges, skipped: "unreadable" });
            continue;
          }
          if (stat.size > maxBytes) {
            files.push({ path: file.path, status: file.status, changedRanges, skipped: "too-large" });
            continue;
          }
          if (estimateTokensFromBytes(stat.size) > remainingTokens) {
            files.push({ path: file.path, status: file.status, changedRanges, skipped: "over-budget" });
            continue;
          }
        } catch {
          // statSync failed — fall through; readFileSync will fail too and mark unreadable.
        }
      }

      const content = gitFileContent(file.path, options) ?? readFileSync(absolute, "utf8");
      const contentBytes = Buffer.byteLength(content, "utf8");
      // Secondary checks: cover the rare case where no pre-load size was
      // available (e.g., cat-file unavailable) but content still loaded.
      if (contentBytes > maxBytes) {
        files.push({ path: file.path, status: file.status, changedRanges, skipped: "too-large" });
        continue;
      }
      const contentTokens = estimateTokensFromBytes(contentBytes);
      if (contentTokens > remainingTokens) {
        files.push({ path: file.path, status: file.status, changedRanges, skipped: "over-budget" });
        continue;
      }
      remainingTokens -= contentTokens;

      const regions = await mapChangedRegions(content, file.path, changedRanges);
      files.push({ path: file.path, status: file.status, changedRanges, content, regions });
    } catch {
      files.push({ path: file.path, status: file.status, changedRanges, skipped: "unreadable" });
    }
  }

  return {
    scope: describeScope(options),
    files,
    reviewable: files.filter((file) => file.content !== undefined)
  };
}
