export interface ChangedRange {
  startLine: number;
  endLine: number;
}

export interface FileDiff {
  path: string;
  changedRanges: ChangedRange[];
}

/**
 * Parse a unified git diff into per-file changed line ranges on the new side.
 * Pure and side-effect free so it can be tested without invoking git.
 * Removed-only lines do not advance the new-side counter; added lines are
 * collected and coalesced into contiguous ranges.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { path: string; added: number[] } | null = null;
  let newLineNo = 0;
  let inHunk = false;

  const flush = (): void => {
    if (current && current.path) {
      files.push({ path: current.path, changedRanges: coalesce(current.added) });
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      current = { path: "", added: [] };
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (current) {
        current.path = target === "/dev/null" ? "" : target.replace(/^[ab]\//, "");
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("@@")) {
      const match = /\+(\d+)/.exec(line.split("@@")[1] ?? "");
      newLineNo = match ? Number(match[1]) : 0;
      inHunk = true;
      continue;
    }

    if (!inHunk || !current) {
      continue;
    }

    if (line.startsWith("+")) {
      current.added.push(newLineNo);
      newLineNo += 1;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // removed line or "No newline at end of file" marker: no new-side advance
    } else {
      newLineNo += 1;
    }
  }

  flush();
  return files;
}

function coalesce(lines: number[]): ChangedRange[] {
  if (lines.length === 0) {
    return [];
  }

  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: ChangedRange[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (const line of sorted.slice(1)) {
    if (line === end + 1) {
      end = line;
    } else {
      ranges.push({ startLine: start, endLine: end });
      start = line;
      end = line;
    }
  }

  ranges.push({ startLine: start, endLine: end });
  return ranges;
}
