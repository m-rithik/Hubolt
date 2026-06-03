import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import type { RepoConfig } from "../config/schema.js";
import { parseUnifiedDiff, type ChangedRange } from "./diff.js";
import { getChangedFiles, getDiffText, type ChangeStatus, type ChangedFilesOptions } from "./git.js";

export type SkipReason = "deleted" | "ignored" | "too-large" | "unreadable";

export interface ReviewFile {
  path: string;
  status: ChangeStatus;
  changedRanges: ChangedRange[];
  content?: string;
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

export function buildContext(options: BuildContextOptions): BuiltContext {
  const cwd = options.cwd ?? process.cwd();
  const { config } = options;

  const changed = getChangedFiles(options);
  const rangesByPath = new Map<string, ChangedRange[]>();
  for (const fileDiff of parseUnifiedDiff(getDiffText(options))) {
    rangesByPath.set(fileDiff.path, fileDiff.changedRanges);
  }

  const isIgnored = config.ignore.length > 0 ? picomatch(config.ignore, { dot: true }) : () => false;
  const maxBytes = config.maxFileSizeKb * 1024;

  const files = changed.map((file): ReviewFile => {
    const changedRanges = rangesByPath.get(file.path) ?? [];

    if (file.status === "deleted") {
      return { path: file.path, status: file.status, changedRanges, skipped: "deleted" };
    }

    if (isIgnored(file.path)) {
      return { path: file.path, status: file.status, changedRanges, skipped: "ignored" };
    }

    const absolute = resolve(cwd, file.path);
    try {
      if (statSync(absolute).size > maxBytes) {
        return { path: file.path, status: file.status, changedRanges, skipped: "too-large" };
      }

      return {
        path: file.path,
        status: file.status,
        changedRanges,
        content: readFileSync(absolute, "utf8")
      };
    } catch {
      return { path: file.path, status: file.status, changedRanges, skipped: "unreadable" };
    }
  });

  return {
    scope: describeScope(options),
    files,
    reviewable: files.filter((file) => file.content !== undefined)
  };
}
