import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt from the Node standard library (no bcrypt/argon2
 * dependency). Stored format: "scrypt$<saltHex>$<hashHex>". Verification is
 * constant-time and returns false for any malformed stored value rather than
 * throwing, so callers can treat it as a plain allow/deny.
 *
 * Policy (length, denylist) lives in the validation layer, not here; this module
 * only hashes and verifies.
 */
const KEYLEN = 64;
const SALT_LENGTH = 16;
const PREFIX = "scrypt";

export function hashPassword(password: string): string {
  if (!password) {
    throw new Error("Password must not be empty");
  }
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(password, salt, KEYLEN);
  return `${PREFIX}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || !stored) {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return false;
  }
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== KEYLEN) {
    return false;
  }
  const actual = scryptSync(password, salt, KEYLEN);
  return timingSafeEqual(expected, actual);
}
