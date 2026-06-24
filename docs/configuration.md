# Configuration

Hubolt is configured in two places:

1. Environment variables - machine secrets and runtime settings (in `.env` /
   `.env.local`, or the real process environment).
2. `.hubolt.yml` - repository review rules, committed to the repo.

Related: [Getting Started](getting-started.md) | [Security](security.md) |
[Deployment](deployment.md)

## Environment variables

All variables found in the codebase. "Required" means the named feature will not
work without it; nothing here is required just to run `hubolt analyze`.

### Core runtime

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `DATABASE_URL` | Yes (server) | none | PostgreSQL connection string. Server refuses to start without it. |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis for the LLM gateway and queue. If unreachable, the gateway is disabled and the server still runs. |
| `PORT` | No | `3000` | Server listen port. |
| `HOST` | No | `127.0.0.1` | Server bind address. Use `0.0.0.0` to expose directly. |
| `NODE_ENV` | No | none | `production` tightens defaults (e.g. CORS disabled unless `CORS_ORIGIN` set). |
| `LOG_LEVEL` | No | `info` | Pino log level (`debug`, `info`, `warn`, `error`). |
| `CORS_ORIGIN` | No | `http://localhost:3000` in dev, disabled in production | Allowed CORS origin for the API. |
| `HUBOLT_CACHE_DIR` | No | local default | Directory for the review result cache. |
| `HUBOLT_REVIEW_CONCURRENCY` | No | provider default | Max concurrent LLM calls during review. |
| `NO_COLOR` | No | unset | Standard flag to disable colored CLI output. |
| `DEBUG` | No | unset | Extra debug output where checked. |

### LLM provider keys (set the one(s) you use)

| Variable | Provider | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | OpenAI | Consumed by the OpenAI adapter (Vercel AI SDK). |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Consumed by the Anthropic adapter. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google (Gemini) | Consumed by the Google adapter. |
| `HUBOLT_LLM_PROVIDER` | - | Default provider (`openai`, `anthropic`, `google`). Overridable per run with `--provider`. |
| `HUBOLT_LLM_MODEL` | - | Default model id. Overridable with `--model`. |

### Server client / gateway

| Variable | Required | Effect |
|----------|----------|--------|
| `HUBOLT_SERVER_URL` | For `push-report`, `history`, `gateway`, `audit` | Base URL of a Hubolt server, e.g. `http://127.0.0.1:3000`. |
| `HUBOLT_API_KEY` | For server-client commands | Bearer API key created by `server bootstrap`. |
| `CREDENTIAL_MASTER_KEY` | For gateway stored credentials | 32-byte key (`openssl rand -base64 32`) used to encrypt provider credentials saved in the DB. Keep it stable; rotating it invalidates stored credentials. |

### GitHub integration

| Variable | Used for |
|----------|----------|
| `GITHUB_TOKEN` / `GH_TOKEN` | Posting PR comments and suggestions (`hubolt github post`). |
| `GITHUB_REPOSITORY` | `owner/repo` context, typically set by GitHub Actions. |
| `GITHUB_WEBHOOK_SECRET` | Verifying inbound webhook signatures (CLI fixture verification). |
| `GITHUB_APP_ID` | GitHub App id (server webhook mode). |
| `GITHUB_APP_SLUG` | GitHub App slug. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM). Never commit. |
| `GITHUB_APP_WEBHOOK_SECRET` | Verifying GitHub App webhook signatures at `POST /webhooks/github`. |

### Notifications (optional)

| Variable | Used for |
|----------|----------|
| `HUBOLT_SLACK_WEBHOOK_URL` | Slack integration adapter. |
| `HUBOLT_TEAMS_WEBHOOK_URL` | Microsoft Teams integration adapter. |

Internal Prisma engine variables (`PRISMA_*`) are managed by Prisma and are not
user-facing.

## Safe example `.env`

This file contains placeholders only and is safe to keep as a template. Put real
values in `.env` / `.env.local` (both git-ignored). A server-oriented copy is at
[`deploy/env.example`](../deploy/env.example).

```bash
# Runtime
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info

# Database (also accepted from .env.local)
DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db"

# Redis (optional)
REDIS_URL=redis://localhost:6379

# LLM provider (set what you use)
HUBOLT_LLM_PROVIDER=openai
HUBOLT_LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
# ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_API_KEY>
# GOOGLE_GENERATIVE_AI_API_KEY=<YOUR_GOOGLE_API_KEY>

# Server client (for push-report / history / gateway)
HUBOLT_SERVER_URL=http://127.0.0.1:3000
HUBOLT_API_KEY=<YOUR_HUBOLT_API_KEY>

# Gateway credential encryption (generate: openssl rand -base64 32)
CREDENTIAL_MASTER_KEY=<YOUR_32_BYTE_BASE64_KEY>

# GitHub (optional)
# GITHUB_TOKEN=<YOUR_GITHUB_TOKEN>
# GITHUB_APP_ID=
# GITHUB_APP_SLUG=
# GITHUB_APP_WEBHOOK_SECRET=
# GITHUB_APP_PRIVATE_KEY=

# Notifications (optional)
# HUBOLT_SLACK_WEBHOOK_URL=
# HUBOLT_TEAMS_WEBHOOK_URL=
```

## `.hubolt.yml` repository configuration

Committed to the repo; controls how reviews behave. The authoritative schema is
`src/config/schema.ts`. A starter file is in [`.hubolt.example.yml`](../.hubolt.example.yml),
and `hubolt setup --print` prints one. Validate yours with:

```bash
npm run dev -- config validate
```

Confirmed top-level keys (from the schema and example):

| Key | Purpose |
|-----|---------|
| `mode` | Review mode, e.g. `balanced`. |
| `severityThreshold` | Minimum severity to report. |
| `failOnSeverity` | Severity that makes `--ci` exit non-zero. |
| `commentBudget` | Max comments per review. |
| `maxFileSizeKb` | Skip files larger than this. |
| `maxContextTokens` | Token budget for model context. |
| `providers.llm`, `providers.model` | Default provider and model. |
| `privacy.*` | `redactSecrets`, `showContextSentToModel`, `allowExternalModels`. |
| `security.*` | Security-mode toggles (secret scan, dependency audit, semgrep rules, etc.). |
| `analyzers.*` | Enable `typescript`, `eslint`, `semgrep`, `secrets`, `dependencies`. |
| `integrations.*` | `slack`, `teams`, `jira`, `clickup`, `asana` settings. |
| `ignore` | Glob patterns to skip. |
| `rules` | Natural-language custom review rules. |

Needs confirmation: the root README also mentions `memory`, `behaviorPacks`, and
`knowledgeFiles` keys. Confirm against `src/config/schema.ts` before relying on
them; use `config validate` to check what your installed version accepts.

## Secrets handling

- `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12` are
  git-ignored. Never commit real secrets.
- On a server, store secrets in `/opt/hubolt/.env` with `chmod 600`.
- In CI, use the platform's secret store (GitHub Actions secrets, Bitbucket
  secured variables) - never inline keys in workflow files.
- See [Security](security.md) for credential encryption and rotation.
