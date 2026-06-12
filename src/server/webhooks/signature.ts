import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

/**
 * Compute the GitHub webhook signature header value for a raw payload body.
 * The payload must be the exact bytes GitHub delivered; re-serialized JSON
 * will not match what was signed.
 */
export function computeGitHubSignature(secret: string, payload: Buffer | string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify an X-Hub-Signature-256 header against the raw payload using a
 * constant-time comparison. Returns false for any malformed input instead of
 * throwing, so callers can treat the result as a plain allow/deny.
 */
export function verifyGitHubSignature(
  secret: string,
  payload: Buffer | string,
  signatureHeader: string | undefined
): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expected = Buffer.from(computeGitHubSignature(secret, payload), "utf8");
  const received = Buffer.from(signatureHeader, "utf8");

  return expected.length === received.length && timingSafeEqual(expected, received);
}
