import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

/**
 * Bare (unquoted) is only safe for simple tokens. Anything with whitespace or
 * shell metacharacters (spaces, ; & | $ ` ( ) etc., or URL query chars like
 * ? & = %) is quoted so dotenv strips the quotes back to the original on load
 * (the .env file is read with dotenv.parse and loaded with dotenv.config).
 */
const BARE_ENV_VALUE = /^[A-Za-z0-9_./:@+-]*$/;

/**
 * Quote a value so dotenv round-trips it exactly. dotenv reads a single-quoted
 * value literally but offers no escape for an embedded single quote, so such
 * values are double-quoted instead. Inside double quotes dotenv only unescapes
 * \n and \r and cannot carry a literal double quote, backslash, or newline, so
 * a value mixing a single quote with any of those is rejected rather than
 * written in a form that would reload as something different.
 */
function serializeEnvValue(value: string): string {
  if (BARE_ENV_VALUE.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (/["\\\r\n]/.test(value)) {
    throw new Error(
      "Cannot store an env value containing a single quote together with a double quote, backslash, or newline"
    );
  }
  return `"${value}"`;
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
