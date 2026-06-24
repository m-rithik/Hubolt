# Security

How Hubolt handles secrets, authentication, and untrusted input, plus how to
report issues.

Related: [Configuration](configuration.md) | [API & Integrations](api.md) |
[Deployment](deployment.md)

## Secrets and credential handling

- Secret files are git-ignored: `.env`, `.env.*` (except `.env.example`), `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, `*.keystore`. Never commit real secrets.
- On a server, keep secrets in `/opt/hubolt/.env` with `chmod 600`.
- In CI, use the platform secret store (GitHub Actions secrets, Bitbucket secured
  variables). The Bitbucket pipeline holds only `DEPLOY_USER`/`DEPLOY_HOST` and an
  SSH key - no application secrets.
- Provider credentials stored in the database (gateway) are encrypted at rest with
  `CREDENTIAL_MASTER_KEY` (see
  [`src/server/services/credential-manager.ts`](../src/server/services/credential-manager.ts)).
  Generate it once with `openssl rand -base64 32` and keep it stable; rotating it
  invalidates stored credentials.

## Authentication and authorization

- Server API uses bearer API keys: `Authorization: Bearer <api-key>`
  ([`src/server/middleware/auth.ts`](../src/server/middleware/auth.ts)).
- API keys are stored as hashes only (`hashApiKey`); the plaintext is shown once at
  creation and cannot be recovered.
- Keys have a role: `admin` or `viewer`. State-changing routes require admin via
  `requireAdmin` (HTTP 403 otherwise).
- Keys can expire (`expiresAt`); expired keys are rejected (HTTP 401).
- Webhooks (`POST /webhooks/github`) are authenticated by signature using
  `GITHUB_APP_WEBHOOK_SECRET`, not by an API key.

## Transport and HTTP hardening

- The server registers `@fastify/helmet` for security headers.
- CORS is restricted: disabled in production unless `CORS_ORIGIN` is set; defaults
  to `http://localhost:3000` in development.
- The app binds to `127.0.0.1` by default. For internet exposure, put it behind a
  reverse proxy with TLS (see [`deploy/README.md`](../deploy/README.md)).

## Handling untrusted input

- Reviewed code, diffs, comments, and repository files are treated as untrusted
  data. Prompts fence untrusted content so it cannot override review instructions.
- Secret redaction runs before prompt construction
  ([`src/core/redact.ts`](../src/core/redact.ts)); `privacy.redactSecrets` controls
  it in `.hubolt.yml`.
- External request bodies are validated with zod before use.
- Hubolt suggests fixes for human review; it does not silently apply patches.

## Security-sensitive configuration

| Setting | Why it matters |
|---------|----------------|
| `HOST=0.0.0.0` | Exposes the server beyond localhost - use a firewall/TLS proxy. |
| `CORS_ORIGIN` | Too-broad an origin weakens browser protections. |
| `CREDENTIAL_MASTER_KEY` | Protects stored provider credentials; treat as a top secret. |
| `privacy.allowExternalModels` | Controls whether code is sent to hosted models. |
| GitHub App keys | `GITHUB_APP_PRIVATE_KEY` grants repo access - never commit. |

## Reporting a vulnerability

There is no committed `SECURITY.md` or formal disclosure process in this
repository (needs maintainer confirmation). Until one exists, report privately to
the maintainer rather than opening a public issue with exploit details. General
issues: https://github.com/m-rithik/hubolt/issues
