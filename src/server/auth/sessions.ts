import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque session tokens for username/password login. The plaintext token is
 * returned to the client once; only its sha256 hash is stored (mirrors the
 * api_keys table), so a database leak does not expose usable tokens.
 */
const PREFIX = "hubsess_";

export function generateSessionToken(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isSessionToken(token: string): boolean {
  return token.startsWith(PREFIX);
}
