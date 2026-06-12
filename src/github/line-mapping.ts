import type { ReviewRange } from "../types/finding.js";
import type { ChangedRange } from "../core/diff.js";
import type { DiffSide, PullRequestFile } from "../providers/scm/scm.interface.js";

/**
 * Index of one file's diff hunks. Line numbers are file coordinates: new-file
 * for the right side, old-file for the left. A line is commentable on a side
 * only when it appears in a hunk on that side; multi-line comments must stay
 * within a single hunk.
 */
export interface FileDiffIndex {
  /** New-file lines visible in the diff (added or context). */
  rightLines: Set<number>;
  /** New-file lines that were added. */
  addedLines: Set<number>;
  /** Old-file lines visible in the diff (deleted or context). */
  leftLines: Set<number>;
  rightHunkByLine: Map<number, number>;
  leftHunkByLine: Map<number, number>;
}

export type DiffIndex = Map<string, FileDiffIndex>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a single file's patch (GitHub API "patch" field: hunks only). */
export function buildFileDiffIndex(patch: string): FileDiffIndex {
  const index: FileDiffIndex = {
    rightLines: new Set(),
    addedLines: new Set(),
    leftLines: new Set(),
    rightHunkByLine: new Map(),
    leftHunkByLine: new Map()
  };

  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk += 1;
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      index.rightLines.add(newLine);
      index.addedLines.add(newLine);
      index.rightHunkByLine.set(newLine, hunk);
      newLine += 1;
    } else if (line.startsWith("-")) {
      index.leftLines.add(oldLine);
      index.leftHunkByLine.set(oldLine, hunk);
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      // "No newline at end of file": advances neither side.
    } else {
      index.rightLines.add(newLine);
      index.rightHunkByLine.set(newLine, hunk);
      index.leftLines.add(oldLine);
      index.leftHunkByLine.set(oldLine, hunk);
      newLine += 1;
      oldLine += 1;
    }
  }

  return index;
}

/** Build an index for all files in a pull request, keyed by current path. */
export function buildDiffIndex(files: PullRequestFile[]): DiffIndex {
  const index: DiffIndex = new Map();
  for (const file of files) {
    if (!file.patch) {
      continue;
    }
    index.set(file.filename, buildFileDiffIndex(file.patch));
  }
  return index;
}

export interface MappedComment {
  path: string;
  line: number;
  startLine?: number;
  side: DiffSide;
  /** "full" when the whole range is commentable; "endLine" when degraded. */
  coverage: "full" | "endLine";
}

export type CommentMapping =
  | { mappable: true; comment: MappedComment }
  | { mappable: false; reason: string };

/**
 * Map a finding range onto diff coordinates. A multi-line range maps fully
 * when every line is visible on the requested side within one hunk; when only
 * the end line is visible the comment degrades to that single line. Anything
 * else belongs in the summary instead of a broken inline comment.
 */
export function mapRangeToComment(range: ReviewRange, index: DiffIndex): CommentMapping {
  const fileIndex = index.get(range.file);
  if (!fileIndex) {
    return { mappable: false, reason: "file is not part of this diff" };
  }

  const side: DiffSide = range.diffSide === "left" ? "LEFT" : "RIGHT";
  const lines = side === "LEFT" ? fileIndex.leftLines : fileIndex.rightLines;
  const hunkByLine = side === "LEFT" ? fileIndex.leftHunkByLine : fileIndex.rightHunkByLine;

  if (!lines.has(range.endLine)) {
    return { mappable: false, reason: `line ${range.endLine} is not visible in the diff` };
  }

  if (range.startLine === range.endLine) {
    return {
      mappable: true,
      comment: { path: range.file, line: range.endLine, side, coverage: "full" }
    };
  }

  const endHunk = hunkByLine.get(range.endLine);
  let fullyVisible = true;
  for (let line = range.startLine; line < range.endLine; line++) {
    if (!lines.has(line) || hunkByLine.get(line) !== endHunk) {
      fullyVisible = false;
      break;
    }
  }

  if (fullyVisible) {
    return {
      mappable: true,
      comment: {
        path: range.file,
        line: range.endLine,
        startLine: range.startLine,
        side,
        coverage: "full"
      }
    };
  }

  return {
    mappable: true,
    comment: { path: range.file, line: range.endLine, side, coverage: "endLine" }
  };
}

/**
 * New-file line ranges this patch added, coalesced into contiguous spans.
 * This is the hosted equivalent of parseUnifiedDiff for a single API patch.
 */
export function changedRangesFromPatch(patch: string): ChangedRange[] {
  const lines = [...buildFileDiffIndex(patch).addedLines].sort((a, b) => a - b);
  const ranges: ChangedRange[] = [];

  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.endLine + 1) {
      last.endLine = line;
    } else {
      ranges.push({ startLine: line, endLine: line });
    }
  }

  return ranges;
}

/**
 * True when every line of the range was added on the right side within one
 * hunk. This is the eligibility bar for suggestion blocks: a suggestion
 * replaces the commented range, so it must target only lines this PR wrote.
 */
export function isRangeFullyAdded(range: ReviewRange, index: DiffIndex): boolean {
  if (range.diffSide === "left") {
    return false;
  }

  const fileIndex = index.get(range.file);
  if (!fileIndex) {
    return false;
  }

  const endHunk = fileIndex.rightHunkByLine.get(range.endLine);
  if (endHunk === undefined) {
    return false;
  }

  for (let line = range.startLine; line <= range.endLine; line++) {
    if (!fileIndex.addedLines.has(line) || fileIndex.rightHunkByLine.get(line) !== endHunk) {
      return false;
    }
  }

  return true;
}
