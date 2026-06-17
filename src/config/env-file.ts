import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

/**
 * Bare (unquoted) is only safe for simple tokens. Anything with whitespace or
 * shell metacharacters (spaces, ; & | $ ` ( ) etc., or URL query chars like
 * ? & = %) is single-quoted, so the value is a shell literal if the file is
 * sourced and dotenv strips the quotes back to the original on load.
 */
const BARE_ENV_VALUE = /^[A-Za-z0-9_./:@+-]*$/;

function serializeEnvValue(value: string): string {
  if (BARE_ENV_VALUE.test(value)) {
    return value;
  }
  // Single-quote; escape any embedded single quote the shell way: ' -> '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Merge KEY=value updates into an existing .env body. Existing keys are updated
 * in place; comments, blank lines, and unrelated keys are preserved; new keys
 * are appended. Values are serialized so the file is safe to load with dotenv
 * and safe to `source` in a shell. Pure so it can be tested without touching
 * the filesystem.
 */
export function applyEnvUpdates(existing: string, updates: Record<string, string>): string {
  const applied = new Set<string>();
  const lines = existing.length > 0 ? existing.split("\n") : [];

  const merged = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      applied.add(match[1]);
      return `${match[1]}=${serializeEnvValue(updates[match[1]])}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!applied.has(key)) {
      merged.push(`${key}=${serializeEnvValue(value)}`);
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

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? dotenv.parse(readFileSync(path, "utf8")) : {};
}
