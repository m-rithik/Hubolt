import { createCipheriv, createDecipheriv, createHash, randomBytes, hkdfSync } from "node:crypto";
import { PrismaClient } from "../../generated/prisma/index.js";

const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEYLEN = 32;
const HASH_ALGORITHM = "sha256";

export interface StoredCredential {
  provider: string;
  keyHash: string;
  encryptedKey: string;
}

export class CredentialManager {
  private masterKey: Buffer;

  constructor(private db: PrismaClient) {
    const masterSecret = process.env.CREDENTIAL_MASTER_KEY;
    if (!masterSecret) {
      throw new Error("CREDENTIAL_MASTER_KEY environment variable is required");
    }
    this.masterKey = Buffer.from(masterSecret, "base64");
    if (this.masterKey.length !== 32) {
      throw new Error("CREDENTIAL_MASTER_KEY must be 32 bytes (base64 encoded)");
    }
  }

  static generateMasterKey(): string {
    return randomBytes(32).toString("base64");
  }

  async storeCredential(orgId: string, provider: string, apiKey: string): Promise<void> {
    const encrypted = this.encryptKey(apiKey);
    const keyHash = this.hashKey(apiKey);

    try {
      await this.db.providerCredential.upsert({
        where: { orgId_provider: { orgId, provider } },
        create: {
          orgId,
          provider,
          keyHash,
          encryptedKey: encrypted
        },
        update: {
          keyHash,
          encryptedKey: encrypted
        }
      });
    } catch (error) {
      throw new Error(`Failed to store credential for ${provider}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async getCredential(orgId: string, provider: string, options: { touchLastUsed?: boolean } = {}): Promise<string | null> {
    try {
      const cred = await this.db.providerCredential.findUnique({
        where: { orgId_provider: { orgId, provider } }
      });

      if (!cred) {
        return null;
      }

      const decrypted = this.decryptKey(cred.encryptedKey);
      if (options.touchLastUsed ?? true) {
        // Best-effort: a failed "last used" write must not block a credential
        // that was retrieved and decrypted successfully.
        try {
          await this.db.providerCredential.update({
            where: { id: cred.id },
            data: { lastUsedAt: new Date() }
          });
        } catch (touchError) {
          console.error("Failed to update credential lastUsedAt:", touchError);
        }
      }

      return decrypted;
    } catch (error) {
      throw new Error(`Failed to retrieve credential: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async listCredentials(orgId: string): Promise<Array<{ provider: string; lastUsedAt: Date | null }>> {
    try {
      const creds = await this.db.providerCredential.findMany({
        where: { orgId },
        select: {
          provider: true,
          lastUsedAt: true
        }
      });
      return creds;
    } catch (error) {
      throw new Error(`Failed to list credentials: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async deleteCredential(orgId: string, provider: string): Promise<void> {
    try {
      await this.db.providerCredential.deleteMany({
        where: { orgId, provider }
      });
    } catch (error) {
      throw new Error(`Failed to delete credential: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private encryptKey(apiKey: string): string {
    const iv = randomBytes(IV_LENGTH);
    const salt = randomBytes(SALT_LENGTH);

    const derived = hkdfSync(HASH_ALGORITHM, this.masterKey, salt, "", KEYLEN);
    const derivedKey = Buffer.from(derived);
    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);

    let encrypted = cipher.update(apiKey, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, "hex")]);

    return combined.toString("base64");
  }

  private decryptKey(encrypted: string): string {
    const combined = Buffer.from(encrypted, "base64");

    const salt = combined.slice(0, SALT_LENGTH);
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = combined.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

    const derived = hkdfSync(HASH_ALGORITHM, this.masterKey, salt, "", KEYLEN);
    const derivedKey = Buffer.from(derived);
    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString("utf8");
  }

  private hashKey(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }
}
