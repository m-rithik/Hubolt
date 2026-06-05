import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return `hubolt_${randomBytes(32).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
