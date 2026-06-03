import { execFileSync } from "node:child_process";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

export interface ChangedFilesOptions {
  cwd?: string;
  staged?: boolean;
  base?: string;
  head?: string;
}

const STATUS_BY_CODE: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added"
};

/**
 * Parse `git diff --name-status` output into changed files.
 * Kept pure so it can be tested without spawning git. Rename lines carry both
 * the old and new path; the new path is reported.
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    const status = STATUS_BY_CODE[parts[0]?.[0] ?? ""];
    const path = parts[parts.length - 1];
    if (status && path) {
      files.push({ path, status });
    }
  }

  return files;
}

export function isGitRepository(cwd: string = process.cwd()): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

export function getChangedFiles(options: ChangedFilesOptions = {}): ChangedFile[] {
  const cwd = options.cwd ?? process.cwd();
  const args = ["diff", "--name-status"];

  if (options.base && options.head) {
    args.push(options.base, options.head);
  } else if (options.staged) {
    args.push("--cached");
  }

  let output: string;
  try {
    output = execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git diff failed: ${detail}`);
  }

  return parseNameStatus(output);
}
