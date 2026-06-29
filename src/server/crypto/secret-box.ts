import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Standalone authenticated encryption for secrets stored inline on a row (e.g.
 * a repository integration's API token / webhook secret), as opposed to the
 * CredentialManager which owns the provider_credentials table. Same AES-256-GCM
 * + per-record HKDF salt scheme and CREDENTIAL_MASTER_KEY, so the security
 * properties match. ponytail: CredentialManager could delegate here later;
 * kept separate now to avoid changing already-encrypted data.
 */
const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEYLEN = 32;

function masterKey(): Buffer {
  const secret = process.env.CREDENTIAL_MASTER_KEY;
  if (!secret) {
    throw new Error("CREDENTIAL_MASTER_KEY environment variable is required");
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_MASTER_KEY must be 32 bytes (base64 encoded)");
  }
  return key;
}

/** Encrypt a secret; returns base64(salt|iv|authTag|ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);
  const derived = Buffer.from(hkdfSync("sha256", masterKey(), salt, "", KEYLEN));
  const cipher = createCipheriv(ALGORITHM, derived, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

/** Decrypt a value produced by encryptSecret. Throws if tampered or wrong key. */
export function decryptSecret(encoded: string): string {
  const combined = Buffer.from(encoded, "base64");
  if (combined.length <= SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext is too short to be valid");
  }
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const derived = Buffer.from(hkdfSync("sha256", masterKey(), salt, "", KEYLEN));
  const decipher = createDecipheriv(ALGORITHM, derived, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Stable sha256 hex of a secret. Used to enforce "no credential reuse across
 * integrations" (unique column) and to detect changes, without ever decrypting.
 */
export function secretFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
