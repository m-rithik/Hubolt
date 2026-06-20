import { createSign } from "node:crypto";

/**
 * GitHub App authentication: mint short-lived installation access tokens so the
 * worker can act on any repo the App is installed on, without storing a
 * per-repo personal access token. An App JWT (signed with the App private key)
 * is exchanged for an installation token that GitHub scopes to that
 * installation and expires in ~1 hour.
 *
 * RS256 is hand-rolled with node:crypto to avoid a JWT dependency: a GitHub App
 * JWT is just `base64url(header).base64url(payload).base64url(signature)`.
 */

const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
// GitHub rejects App JWTs whose exp is more than 10 minutes out; stay under it.
const JWT_LIFETIME_SEC = 9 * 60;
const JWT_CLOCK_SKEW_SEC = 60;
// Refresh installation tokens a few minutes before expiry so an in-flight job
// never races the boundary.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  /** App private key in PEM form (PKCS#1 or PKCS#8). */
  privateKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class GitHubAppAuth {
  private appId: string;
  private privateKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private now: () => number;
  // ponytail: process-local cache, fine for a single worker; if the worker
  // fleet scales out, move to Redis keyed by installation id.
  private cache = new Map<string, CachedToken>();

  constructor(config: GitHubAppConfig) {
    if (!config.appId) {
      throw new Error("GitHub App id is required");
    }
    if (!config.privateKey) {
      throw new Error("GitHub App private key is required");
    }
    this.appId = config.appId;
    this.privateKey = normalizePrivateKey(config.privateKey);
    this.baseUrl = (config.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /** Build a short-lived JWT that authenticates as the App itself. */
  createAppJwt(): string {
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: nowSec - JWT_CLOCK_SKEW_SEC,
      exp: nowSec + JWT_LIFETIME_SEC,
      iss: this.appId
    };

    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  /**
   * Return a valid installation access token, minting a fresh one when the
   * cached token is missing or near expiry.
   */
  async getInstallationToken(installationId: string): Promise<string> {
    if (!installationId) {
      throw new Error("An installation id is required to mint a token");
    }

    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > this.now()) {
      return cached.token;
    }

    const jwt = this.createAppJwt();
    const response = await this.fetchImpl(
      `${this.baseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: JSON_ACCEPT,
          authorization: `Bearer ${jwt}`,
          "user-agent": "hubolt",
          "x-github-api-version": API_VERSION
        }
      }
    );

    if (!response.ok) {
      // Never echo the response body: it is controlled input and the failure
      // status is enough to diagnose a misconfigured App.
      throw new Error(
        `Failed to mint installation token (${response.status}) for installation ${installationId}`
      );
    }

    const body = (await response.json()) as { token?: string; expires_at?: string };
    if (!body.token) {
      throw new Error(`GitHub returned no token for installation ${installationId}`);
    }

    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : this.now() + FALLBACK_TOKEN_TTL_MS;
    this.cache.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }
}

/** True when the App is configured via environment variables. */
export function isGitHubAppConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

let sharedAuth: GitHubAppAuth | null = null;

/** Process-wide App auth built from the environment. */
export function getGitHubAppAuth(): GitHubAppAuth {
  if (!isGitHubAppConfigured()) {
    throw new Error("GitHub App is not configured; set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  }
  if (!sharedAuth) {
    sharedAuth = new GitHubAppAuth({
      appId: process.env.GITHUB_APP_ID as string,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY as string
    });
  }
  return sharedAuth;
}

/** Public install URL for the dashboard, or null when the slug is unset. */
export function gitHubAppInstallUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Accept private keys stored with literal "\n" escapes (common when a PEM is
 * pasted into a single-line environment variable).
 */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}
