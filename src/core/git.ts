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
  C: "added",
  T: "modified"
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

export function getGitRoot(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git root lookup failed: ${detail}`);
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
    output = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git diff failed: ${detail}`);
  }

  return parseNameStatus(output);
}

export function getDiffText(options: ChangedFilesOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const args = ["diff", "--unified=3"];

  if (options.base && options.head) {
    args.push(options.base, options.head);
  } else if (options.staged) {
    args.push("--cached");
  }

  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git diff failed: ${detail}`);
  }
}

/**
 * Return the byte size of a file from git without loading its content.
 * Uses `git cat-file -s` so the blob is never buffered.
 * Returns null for working-tree mode or when the ref cannot be resolved.
 */
export function gitFileSize(path: string, options: ChangedFilesOptions = {}): number | null {
  const cwd = options.cwd ?? process.cwd();
  let ref: string;

  if (options.base && options.head) {
    ref = `${options.head}:${path}`;
  } else if (options.staged) {
    ref = `:${path}`;
  } else {
    return null;
  }

  try {
    const out = execFileSync("git", ["cat-file", "-s", ref], { cwd, encoding: "utf8" });
    const size = Number.parseInt(out.trim(), 10);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/**
 * Read a file's content from git, not from disk.
 * - staged: reads the index version (`git show :<path>`)
 * - commit range: reads from the head ref (`git show <head>:<path>`)
 * - working tree: falls back to null (caller reads disk)
 */
export function gitFileContent(path: string, options: ChangedFilesOptions = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  let ref: string;

  if (options.base && options.head) {
    ref = `${options.head}:${path}`;
  } else if (options.staged) {
    ref = `:${path}`;
  } else {
    return null;
  }

  try {
    return execFileSync("git", ["show", ref], { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return null;
  }
}
