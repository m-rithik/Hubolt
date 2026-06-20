import { describe, expect, test, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GitHubAppAuth } from "../../src/server/services/github-app.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("GitHubAppAuth", () => {
  test("creates a verifiable RS256 JWT with App claims", () => {
    const { publicKey, privateKey } = keyPair();
    const auth = new GitHubAppAuth({ appId: "12345", privateKey, now: () => 1_000_000_000_000 });

    const jwt = auth.createAppJwt();
    const [header, payload, signature] = jwt.split(".");
    expect(header && payload && signature).toBeTruthy();

    expect(decodeSegment(header)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decodeSegment(payload);
    expect(claims.iss).toBe("12345");
    expect(claims.exp as number).toBeGreaterThan(claims.iat as number);

    const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  test("mints an installation token and caches it until near expiry", async () => {
    const { privateKey } = keyPair();
    let nowMs = 1_000_000_000_000;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_installation_token", expires_at: new Date(nowMs + 3_600_000).toISOString() })
    });

    const auth = new GitHubAppAuth({
      appId: "12345",
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs
    });

    const first = await auth.getInstallationToken("99");
    const second = await auth.getInstallationToken("99");

    expect(first).toBe("ghs_installation_token");
    expect(second).toBe("ghs_installation_token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("/app/installations/99/access_tokens");

    // After the refresh window, the next read mints again.
    nowMs += 3_600_000;
    await auth.getInstallationToken("99");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("throws without leaking the response body on failure", async () => {
    const { privateKey } = keyPair();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ message: "secret detail" }) });
    const auth = new GitHubAppAuth({ appId: "1", privateKey, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(auth.getInstallationToken("7")).rejects.toThrow(/Failed to mint installation token \(404\)/);
    await expect(auth.getInstallationToken("7")).rejects.not.toThrow(/secret detail/);
  });
});
