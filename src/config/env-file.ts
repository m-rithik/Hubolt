import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Merge KEY=value updates into an existing .env body. Existing keys are updated
 * in place; comments, blank lines, and unrelated keys are preserved; new keys
 * are appended. Pure so it can be tested without touching the filesystem.
 */
export function applyEnvUpdates(existing: string, updates: Record<string, string>): string {
  const applied = new Set<string>();
  const lines = existing.length > 0 ? existing.split("\n") : [];

  const merged = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      applied.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!applied.has(key)) {
      merged.push(`${key}=${value}`);
    }
  }

  return `${merged.join("\n").replace(/\n+$/, "")}\n`;
}

export function writeEnvFile(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, applyEnvUpdates(existing, updates));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; not all filesystems support chmod
  }
}
