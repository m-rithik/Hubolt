# Hubolt Production Deployment and Hosting Guide

This guide is tailored to what is actually in this repository: a TypeScript /
Node (>= 20.19) app with a Fastify API server, a PostgreSQL database (Prisma),
a Redis + BullMQ review queue, a background worker, a static dashboard, and
GitHub + Bitbucket webhook endpoints.

It complements the existing files rather than replacing them:

| Existing file | What it is |
|---------------|------------|
| [`deploy/README.md`](../deploy/README.md) | Step-by-step single-server (no Docker) setup. The canonical install runbook. |
| [`deploy/hubolt-server.service`](../deploy/hubolt-server.service) | systemd unit for the API server. |
| [`deploy/deploy.sh`](../deploy/deploy.sh) / [`deploy/rollback.sh`](../deploy/rollback.sh) | Pull/build/migrate/restart + auto-rollback. |
| [`deploy/env.example`](../deploy/env.example) | Server `.env` template. |
| [`bitbucket-pipelines.yml`](../bitbucket-pipelines.yml) | CI + deploy pipeline. |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | CI (typecheck, test, drift check). |
| [`docker-compose.yml`](../docker-compose.yml) | Postgres + Redis for local dev only. |
| [`docs/deployment.md`](deployment.md) | Short deployment overview. |

---

## 1. Architecture overview

### Deployable parts

| Part | Process / artifact | Required? | Notes |
|------|--------------------|-----------|-------|
| API server | `node dist/server/index.js` (Fastify) | Yes | Serves REST API, the dashboard UI, and both webhook endpoints. Binds `HOST:PORT` (default `127.0.0.1:3000`). |
| Review worker | `node dist/cli/index.js worker start` | Yes, if you use GitHub webhooks | BullMQ consumer for the `hubolt-review-jobs` queue. The GitHub webhook only enqueues; this process runs the actual review. |
| PostgreSQL | external service | Yes | All persistent data (orgs, repos, reviews, findings, users, sessions, audit, budgets, encrypted credentials). Prisma-managed, 17 migrations. |
| Redis | external service | Yes for GitHub flow + LLM gateway; optional otherwise | Backs the BullMQ queue and the LLM gateway cache. If Redis is down the server still starts but GitHub webhook ingest and the gateway are disabled (see `src/server/index.ts`, `src/server/app.ts`). |
| Dashboard (frontend) | static files in [`web/`](../web/) | Yes (served by API) | Plain HTML/JS served by `@fastify/static` from the same server. No separate build or host needed. |
| GitHub webhook endpoint | `POST /webhooks/github` | If GitHub integration used | HMAC-verified, enqueues a job, returns `202`. |
| Bitbucket webhook endpoint | `POST /webhooks/bitbucket` | If Bitbucket integration used | HMAC-verified, runs the review in-process in the background, returns `202`. |

There are **no cron jobs** and no separate scheduler in this codebase. Budget
month resets and similar are handled inline in request/job logic.

### What must run continuously

```
API server   (always)      -> systemd / container / platform process
Review worker (always*)     -> only needed for the GitHub webhook path
PostgreSQL   (always)
Redis        (always*)      -> needed for GitHub queue + LLM gateway
```

\* The Bitbucket review path does **not** use Redis or the worker. It runs the
review in the same Node process as the API server (`void runBitbucketReview(...)`
in `src/server/routes/bitbucket-webhooks.ts`). GitHub reviews are queued and
require both Redis and the worker.

### How webhooks reach the server

```
GitHub / Bitbucket (cloud)
        |  HTTPS POST, signed with HMAC-SHA256 of the raw body
        v
   Reverse proxy / load balancer (TLS termination)   <-- public, port 443
        |  proxy to 127.0.0.1:3000
        v
   Fastify API server
        |
        |-- /webhooks/github   --> verify signature --> enqueue BullMQ job --> 202
        |                                                     |
        |                                                     v
        |                                            Review worker (BullMQ)
        |                                                     |
        |                                                     v
        |                                       fetch PR diff, run LLM review,
        |                                       persist to Postgres, post comments
        |
        '-- /webhooks/bitbucket --> verify signature --> run review in background --> 202
```

---

## 2. Hosting options

This repo is built around a **single Linux server, no Docker for the app**
(systemd + Bitbucket Pipelines). That is the path with finished tooling in
`deploy/`. Everything below is ranked against that reality.

| Option | Fit | Notes |
|--------|-----|-------|
| **Single VPS (Ubuntu) + systemd** | Easiest for a small team. Recommended starting point. | Exactly what `deploy/README.md` automates: Node + Postgres + Redis via apt, server (and worker) under systemd, Bitbucket Pipelines deploys over SSH. One box, low cost, full control. |
| **Render / Railway / Fly.io** | Easy managed PaaS | Run the server as a web service and the worker as a second service/process; add managed Postgres and Redis. No Dockerfile ships in this repo, so you either use the platform's Node buildpack (`npm ci && npm run build`, start `node dist/server/index.js`) or add a Dockerfile (template in section 6). |
| **DigitalOcean App Platform / AWS (ECS/Fargate, App Runner) / GCP Cloud Run** | Good for production scale | Containerize (add Dockerfile), run server and worker as separate services, use managed Postgres (RDS / Cloud SQL) and Redis (ElastiCache / Memorystore). |
| **Kubernetes** | Best for production scale, most ops overhead | Two Deployments (server, worker), managed Postgres + Redis, an Ingress with TLS, secrets in a secret manager. Overkill for a small team. |

Recommendation:

- **Small team / getting to production fast:** single VPS + systemd, per
  `deploy/README.md`. Add the worker unit from section 6.
- **Production scale:** containerize, split server and worker, move Postgres and
  Redis to managed services, put the server behind a load balancer with TLS, and
  scale the worker horizontally (BullMQ supports many workers on one queue).

---

## 3. Production requirements

### Environment variables

All variables are read from `process.env`; the server and worker also load a
`.env` (then `.env.local`, overriding) from the working directory via dotenv
(`src/config/env.ts`).

Required:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string. `postgresql://USER:PASS@HOST:PORT/DB`. |
| At least one LLM key | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`. |

Required for specific features:

| Variable | Needed for |
|----------|------------|
| `REDIS_URL` | GitHub webhook queue + LLM gateway. Defaults to `redis://localhost:6379`. |
| `CREDENTIAL_MASTER_KEY` | Encrypting stored provider credentials and Bitbucket/GitHub integration tokens + webhook secrets at rest. 32 bytes, base64 (`openssl rand -base64 32`). Required for the Bitbucket integration and for any dashboard-stored credentials. |
| `GITHUB_WEBHOOK_SECRET` and/or `GITHUB_APP_WEBHOOK_SECRET` | Enabling the GitHub webhook endpoint (at least one must be set, plus Redis). |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | GitHub App auth so the worker can mint installation tokens to post reviews. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Fallback PAT for the worker when no GitHub App is configured. |

Runtime / optional:

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | - | Set to `production`. Controls CORS default (locks down when `production`). |
| `HOST` | `127.0.0.1` | Bind address. Keep on localhost behind a reverse proxy. |
| `PORT` | `3000` | Listen port. |
| `LOG_LEVEL` | `info` | pino level. |
| `CORS_ORIGIN` | `false` in production | Allowed dashboard origin(s). |
| `TRUST_PROXY` | `false` | Fastify trusted-proxy setting for `X-Forwarded-*` parsing. Set only when behind a controlled proxy/LB (`true`, hop count, IP, CIDR, or comma-separated list). |
| `HUBOLT_REVIEW_CONCURRENCY` / worker `--concurrency` | `2` | Parallel review jobs per worker. |
| `HUBOLT_CACHE_DIR` | - | On-disk cache location (set to a writable path on the server). |
| `HUBOLT_SERVER_URL`, `HUBOLT_API_KEY` | - | Only for the CLI talking to a remote server. |
| `HUBOLT_LLM_PROVIDER`, `HUBOLT_LLM_MODEL` | - | Default provider/model when not set per org. |
| `HUBOLT_SLACK_WEBHOOK_URL`, `HUBOLT_TEAMS_WEBHOOK_URL` | - | CLI/local notification webhooks. Hosted review notifications are repo-scoped; see Notifications. |
| `HUBOLT_JIRA_TOKEN`, `HUBOLT_JIRA_BASE_URL`, `HUBOLT_JIRA_EMAIL`, `HUBOLT_CLICKUP_TOKEN`, `HUBOLT_ASANA_TOKEN` | - | Issue-tracker integrations. These env names are hardcoded on purpose (see `src/integrations/env-names.ts`) so untrusted repo config cannot remap them onto other secrets. |
| `SHADOW_DATABASE_URL` | - | Required for `npm run db:check-drift` in local/CI environments when Prisma diffs migrations. Use a throwaway database, never production. |

### Secret management

- The real `.env` lives only on the server (`chmod 600`) or in the platform's
  secret store. It is git-ignored. `deploy/env.example` is the safe, placeholder
  template that is committed.
- API keys, webhook secrets, DB URL, and provider keys never go into Bitbucket /
  GitHub variables except `DEPLOY_USER` / `DEPLOY_HOST` (which are not secrets).
- Dashboard-stored secrets (Bitbucket API token, per-repo webhook secret, org
  provider keys) are encrypted at rest with AES-256-GCM keyed off
  `CREDENTIAL_MASTER_KEY` (`src/server/crypto/secret-box.ts`,
  `CredentialManager`). Keep `CREDENTIAL_MASTER_KEY` stable; rotating it makes
  existing ciphertext undecryptable.
- On a PaaS/cloud, use the platform secret store (Render/Railway env groups, AWS
  Secrets Manager / SSM, GCP Secret Manager, K8s Secrets) instead of a file.

### Domain, DNS, HTTPS/SSL, reverse proxy, firewall, CORS

- The app binds to `127.0.0.1` by design. Put a reverse proxy (nginx / Caddy /
  platform LB) in front for TLS termination and forward to `127.0.0.1:3000`.
- DNS: point an `A`/`AAAA` (or `CNAME` on PaaS) record at the proxy/LB.
- HTTPS: required. Webhooks must be delivered over HTTPS. Use Let's Encrypt
  (certbot) on a VPS or platform-managed certs.
- Firewall: allow `443` (and `22` for SSH) inbound; keep `3000`, Postgres
  (`5432`), and Redis (`6379`) closed to the public internet.
- CORS: set `CORS_ORIGIN` to your dashboard origin. In `production` the default
  is `false` (no cross-origin), which is correct if the dashboard is served from
  the same origin as the API (it is, by default).
- `@fastify/helmet` is enabled, so standard security headers are set.

### Notifications (Slack / Teams)

The app posts review results outbound to Slack (and Teams) via incoming
webhooks. Slack sends exactly one batched message per review - a summary plus a
capped list of notable findings - never one message per finding
(`src/integrations/slack.ts`). The webhook URL is treated as a secret and is
only ever sent to Slack.

Hosted GitHub and Bitbucket reviews use **per-repository** notification
destinations. Set a Slack webhook on the repo's integration in the dashboard; it
is stored encrypted at rest (`encryptedSlackWebhook`, keyed off
`CREDENTIAL_MASTER_KEY`). During hosted review dispatch, the server clears the
process-wide Slack/Teams webhook env values and supplies only that repo's
webhook, so one tenant cannot accidentally notify another tenant's Slack
workspace (`src/queue/review-processor.ts`,
`src/server/services/bitbucket-review.ts`).

`HUBOLT_SLACK_WEBHOOK_URL` and `HUBOLT_TEAMS_WEBHOOK_URL` still exist for
CLI/local review commands and single-tenant operator workflows that call
`buildIntegrations` directly. Do not rely on them as a hosted multi-tenant
fallback.

To get a Slack incoming-webhook URL: Slack > your app/workspace > Incoming
Webhooks > Add New Webhook, pick the channel, copy the
`https://hooks.slack.com/services/...` URL, and paste it into the repo's
integration form. The env names are hardcoded on purpose so untrusted repo
config cannot remap them (`src/integrations/env-names.ts`).

---

## 4. Database and queue setup

### PostgreSQL

- Engine: PostgreSQL (schema + migrations are Postgres-specific). `postgres:16`
  is used in dev and CI.
- Self-managed (VPS): install via apt (see `deploy/README.md` step 1), create
  the user and database (step 3).
- Managed: provision RDS / Cloud SQL / Supabase / etc. and set `DATABASE_URL`.
  Nothing in the app changes; only the connection string moves.

Migration commands:

```bash
npm run db:migrate        # prisma migrate deploy  (apply on every deploy)
npm run db:check-drift    # fail if schema changed without a migration (run in CI)
npm run db:studio         # prisma studio (inspect data; do not expose publicly)
npm run db:reset          # DANGER: drops and recreates (dev only)
```

`deploy/deploy.sh` runs `prisma migrate deploy` on every deploy after loading
`.env`.

`npm run db:check-drift` needs `SHADOW_DATABASE_URL` because
`prisma.config.ts` configures Prisma's shadow database explicitly. Point it at a
throwaway Postgres database owned by the same role. Never reuse the production
database as the shadow database.

Backups, retention, recovery:

```bash
# Backup (run before any deploy that includes a destructive migration)
pg_dump hubolt_db > backups/hubolt_db_$(date +%F_%H%M).sql

# Restore
psql hubolt_db < backups/hubolt_db_YYYY-MM-DD_HHMM.sql
```

- Schedule daily `pg_dump` (cron on the box, or the managed provider's automated
  backups). Keep a retention window (e.g. 7 daily + 4 weekly) off-box.
- Prisma has **no down-migrations**. Additive migrations are backward compatible;
  a destructive one (dropped/renamed column) must be reversed from a backup.
  Always back up before destructive migrations.

### Redis + BullMQ

- Engine: Redis 7. Used for the BullMQ queue `hubolt-review-jobs` and the LLM
  gateway cache.
- Self-managed: install via apt. Managed: ElastiCache / Memorystore / Upstash;
  set `REDIS_URL` (use `rediss://` for TLS, which the client detects).
- Queue behavior (from `src/queue/review-jobs.ts`):
  - Job id is `repoId:prNumber:headSha`, so redelivered/duplicate webhooks for
    the same PR head are de-duplicated (idempotent enqueue).
  - 3 attempts, exponential backoff starting at 5s.
  - Completed and failed jobs are auto-removed after 24h (`age: 86400`).
  - Worker concurrency defaults to 2 (`--concurrency`, lock duration 120s).
- BullMQ requires `maxRetriesPerRequest: null` on the connection; the repo's
  Redis helper already sets this. Do not override it.

---

## 5. Webhook hosting

### Exposing a secure public endpoint

Webhooks must hit a public HTTPS URL that proxies to the server. With the
reverse proxy from section 3:

- GitHub: `https://your.domain.com/webhooks/github`
- Bitbucket: `https://your.domain.com/webhooks/bitbucket`

For local testing, tunnel with `ngrok http 3000` (or cloudflared) and use the
tunnel URL.

### GitHub webhook setup

1. Set `GITHUB_WEBHOOK_SECRET` (or `GITHUB_APP_WEBHOOK_SECRET`) in the server
   `.env`, plus `REDIS_URL`. Without a secret **and** Redis, the GitHub endpoint
   is not registered (see `src/server/app.ts`).
2. Make sure the **review worker is running** (section 6) - the endpoint only
   enqueues.
3. In GitHub (repo or App settings) add a webhook:
   - Payload URL: `https://your.domain.com/webhooks/github`
   - Content type: `application/json`
   - Secret: the same value as `GITHUB_WEBHOOK_SECRET`
   - Events: Pull requests (and Installation + Installation repositories, if
     using a GitHub App).
4. Register the repository in the Hubolt dashboard so deliveries are matched to
   an org. The Hubolt organization slug must match the GitHub owner/account
   login for that repo (case-insensitive). Matching requires the repo full name,
   the App installation id, and that owner/organization binding.

### Bitbucket webhook setup

1. In the Hubolt dashboard, create a Bitbucket integration for the repository:
   provide the Bitbucket API token and a webhook secret. Both are stored
   encrypted (requires `CREDENTIAL_MASTER_KEY`).
2. In Bitbucket: Repository settings > Webhooks > Add webhook:
   - URL: `https://your.domain.com/webhooks/bitbucket`
   - Triggers: Pull request - Created, Updated.
   - Set the secret to the same value configured in the dashboard.
3. No worker or Redis is needed for Bitbucket; the review runs in the server
   process in the background.

### Signature verification, replay, retries, timeouts, fast ack

- **Signature verification:** both endpoints verify an HMAC-SHA256 of the *raw*
  request body using `verifyGitHubSignature` (constant-time compare,
  `src/server/webhooks/signature.ts`). The raw bytes are preserved with a
  buffer content-type parser; re-serialized JSON would not match. GitHub uses
  `X-Hub-Signature-256`; Bitbucket uses `X-Hub-Signature` with the per-repo
  secret. Bad signature -> `401`. The GitHub server accepts a delivery that
  matches *either* configured secret (standalone or App).
- **Replay protection / idempotency:** GitHub jobs are keyed by
  `repoId:prNumber:headSha`, so a replayed PR delivery for the same head is not
  processed twice at the queue boundary. GitHub App installation mutations also
  claim `webhook_deliveries` with a unique `(provider, deliveryId)` record; a
  missing delivery id is rejected and a duplicate delivery returns `202` without
  reapplying the mutation. Hosted review execution uses `review_locks` to avoid
  duplicate in-flight processing for the same repo/PR/head, and the ingest API
  uses `review_ingest_locks` for the same reason. Bitbucket also checks persisted
  pull-request state after the lock so completed heads are skipped.
- **Retries:** failed review jobs retry 3x with exponential backoff. Provider
  retries (GitHub/Bitbucket re-sending a delivery) are absorbed by the
  idempotent job id.
- **Timeouts / fast acknowledgment:** handlers verify and enqueue (GitHub) or
  kick off a background promise (Bitbucket), then return `202` immediately.
  Skipped/ignored events also return `202` (not an error) so the provider does
  not mark the delivery failed and retry it. Unparseable body -> `400`, bad
  signature -> `401`.
- **Why enqueue instead of reviewing synchronously:** an LLM review takes many
  seconds to minutes - far longer than the provider's webhook timeout (~10s for
  GitHub). Doing it inline would time out, trigger provider retries, and pile up
  duplicate reviews. Enqueuing lets the handler ack in milliseconds while the
  worker does the slow work with retries and concurrency control. (The Bitbucket
  path achieves the fast ack with a background promise instead of a queue; for
  high volume, route it through the queue too.)

---

## 6. Deployment steps

### A. Single server, no Docker (recommended; matches `deploy/`)

The full runbook is `deploy/README.md`. Condensed:

```bash
# One-time provisioning (Ubuntu): Node 20, Postgres 16, Redis, firewall
#   -> see deploy/README.md sections 1-3

# Configure secrets on the server
cd /opt/hubolt
cp deploy/env.example .env && nano .env && chmod 600 .env

# Build + migrate + start the API server (systemd)
npm ci
npm run build                              # runs prisma generate, compiles to dist/
set -a; . ./.env; set +a
npx prisma migrate deploy
sudo cp deploy/hubolt-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hubolt-server

# Health check
curl -fsS http://127.0.0.1:3000/health     # database.connected should be true
```

Run the **worker** as a second systemd service (the existing
`deploy/README.md` step 14 mentions this; use the corrected `ExecStart` below).
Create `/etc/systemd/system/hubolt-worker.service`:

```ini
[Unit]
Description=Hubolt review worker
After=network.target postgresql.service redis-server.service
Wants=postgresql.service redis-server.service

[Service]
Type=simple
User=hubolt
Group=hubolt
WorkingDirectory=/opt/hubolt
ExecStart=/usr/bin/node dist/cli/index.js worker start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HUBOLT_CACHE_DIR=/opt/hubolt/.cache
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hubolt-worker
systemctl status hubolt-worker --no-pager
```

Deploy an update / rollback:

```bash
cd /opt/hubolt && bash deploy/deploy.sh      # pull, build, migrate, restart, health-check, auto-rollback
cd /opt/hubolt && bash deploy/rollback.sh    # revert to previous commit (code only; DB is manual)
```

`deploy/deploy.sh` and `deploy/rollback.sh` restart `hubolt-worker` automatically
when the unit is installed and enabled on the host. If you run a custom worker
process instead of the shipped unit, restart that process after code changes.

### B. Docker / Docker Compose

The shipped `docker-compose.yml` runs **only Postgres + Redis for local
development** - there is no app image in the repo. For local dev:

```bash
npm run db:start        # docker-compose up -d  (Postgres + Redis)
npm run db:migrate
npm run dev:server      # tsx src/server/index.ts
# in another shell, for the GitHub flow:
npm run dev -- worker start
```

To containerize the app for production, add a Dockerfile (not currently in the
repo) such as:

```dockerfile
# Dockerfile (optional - add if you want a container image)
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
```

Run the worker from the same image with `command: node dist/cli/index.js worker start`.
Run `npx prisma migrate deploy` as a one-off before starting (init container /
release command), not inside the long-running container.

### Health checks

- `GET /health` - returns `200` with `database.connected: true`, `503` if the DB
  is unreachable. Use for liveness/readiness.
- `GET /ready` - `200`/`503`, DB ping only, no internal detail leaked. Good for
  load-balancer health probes.

---

## 7. CI/CD deployment

### What ships in the repo

- **GitHub Actions CI** (`.github/workflows/ci.yml`): on PRs and pushes to
  `main`/`master`, on Node 20 - `npm ci`, `prisma generate`, `npm run typecheck`,
  `npm test`, then `db:check-drift` against a throwaway `postgres:16` service.
- **Bitbucket Pipelines** (`bitbucket-pipelines.yml`): on PRs and `main` -
  `npm ci`, `typecheck`, `test`, `build`. On `main`, a **manual** "Deploy to
  server" step SSHes in and runs `deploy/deploy.sh`. Remove `trigger: manual`
  for auto-deploy on every green `main`.

### Deploying automatically from GitHub Actions

The repo deploys via Bitbucket Pipelines today. To deploy from GitHub Actions
instead, add a job gated on a protected environment that SSHes in and runs the
same script:

```yaml
# .github/workflows/deploy.yml (template)
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production          # requires approval if you enable required reviewers
    steps:
      - uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.DEPLOY_SSH_KEY }}
      - run: |
          ssh -o StrictHostKeyChecking=accept-new \
            "${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_HOST }}" \
            "cd /opt/hubolt && bash deploy/deploy.sh"
```

### Separate environments (dev / staging / production)

- Use one server (or PaaS service) per environment, each with its own `.env`,
  database, and Redis. Never share a `DATABASE_URL` or `CREDENTIAL_MASTER_KEY`
  across environments.
- Map branches to environments: e.g. `main` -> staging auto, a `release`/tag ->
  production with approval. In GitHub Actions use `environment:` (with required
  reviewers) for approvals; in Bitbucket use Deployments
  (`deployment: production`) and `trigger: manual`.

### Safe secret handling and approvals

- Secrets live in the platform's encrypted store (GitHub Environments secrets,
  Bitbucket repository/deployment variables marked Secured), never in the repo.
- The only deploy inputs are SSH key + `DEPLOY_USER` + `DEPLOY_HOST`. App
  secrets stay in the server `.env`.
- Gate production with a manual approval (GitHub required reviewers /
  Bitbucket manual trigger).

---

## 8. Operational guidance

### Logging, monitoring, alerting

- Logs: the server uses pino via Fastify (`LOG_LEVEL`, pretty in dev). Under
  systemd, view with `journalctl -u hubolt-server -f` and
  `journalctl -u hubolt-worker -f`. Ship to a log service if desired.
- Health/uptime: poll `/health` (and `/ready`) from an uptime monitor; alert on
  non-200 or `database.connected: false`.
- Error tracking: no Sentry/etc. is wired in. Add one in
  `src/server/index.ts` / the worker bootstrap if you want aggregated errors.
- Queue monitoring: inspect Redis / BullMQ. Quick checks:
  `redis-cli LLEN bull:hubolt-review-jobs:wait`,
  `... :failed`. Worker logs each job's outcome (skipped / posted / failed).
- Audit logs: the app records `AuditEvent` rows (see `src/server/routes/audit.ts`
  and the `audit_events` table) for state changes. Surface them via the audit
  route / dashboard.

### Troubleshooting

- **Failed webhooks:** check the provider's webhook delivery log first.
  `401` = secret mismatch (check `GITHUB_WEBHOOK_SECRET` / the per-repo Bitbucket
  secret). `202` with `reason` = accepted but skipped (repo not registered, no
  installation id, no integration, or GitHub owner/org mismatch). `400` =
  malformed body.
- **GitHub deliveries 202 but no review appears:** the worker is not running or
  Redis is down. Check `systemctl status hubolt-worker` and worker logs; confirm
  `REDIS_URL` and that a webhook secret is set (otherwise the endpoint is not
  even registered). If the reason is `installation is not registered for this
  repository`, confirm the Hubolt org slug matches the GitHub owner login and
  that GitHub has delivered an App installation event for that repo.
- **Failed jobs:** worker logs `Review job <id> failed`. Common causes: no
  GitHub credential (App not configured and no `GITHUB_TOKEN`), provider/API
  error, or LLM key/budget. Jobs retry 3x; persistent failures stay in the
  failed set for 24h.
- **Database issues:** `/health` shows `database.connected: false`. Verify
  Postgres is up, `DATABASE_URL` is correct, and migrations are applied
  (`npm run db:migrate`). `db:check-drift` flags schema/migration mismatch; if
  it fails before diffing, set `SHADOW_DATABASE_URL` to a separate throwaway
  Postgres database.
- **Provider/API failures:** check org budgets/rate limits, the provider key,
  and `GatewayLog` rows. The worker fails closed when a stored credential cannot
  be decrypted (wrong/changed `CREDENTIAL_MASTER_KEY`) rather than billing the
  wrong account.

### Rotating credentials without downtime

- **LLM provider keys:** update the org credential in the dashboard or the env
  var, then restart the worker. New jobs pick up the new key; in-flight jobs
  finish on the old one.
- **GitHub webhook secret:** set both old and new - the GitHub endpoint accepts
  a delivery matching *either* `GITHUB_WEBHOOK_SECRET` or
  `GITHUB_APP_WEBHOOK_SECRET`. Roll by putting the new secret in one slot,
  updating GitHub, then removing the old.
- **Bitbucket token/secret:** update the integration in the dashboard
  (re-encrypted at rest); takes effect on the next delivery.
- **`CREDENTIAL_MASTER_KEY`:** cannot be rotated in place - existing ciphertext
  becomes undecryptable. To rotate, re-enter every stored credential under the
  new key. Treat it as long-lived.
- **DB password:** change in Postgres and `DATABASE_URL` together, then restart
  server and worker.

---

## 9. Security checklist

- [ ] **Admin/developer access control:** users have roles (`admin` /
      `developer`); API keys have roles (`admin` / `viewer`). Admin is required
      to register repos, manage keys, set credentials/budgets. Keep admin
      accounts minimal.
- [ ] **Repository-level permissions:** `RepositoryAccess` grants per-member
      `read` / `actions` access. Grant least privilege.
- [ ] **Auth hardening:** username/password login uses scrypt hashing
      (`src/server/auth/passwords.ts`), opaque session tokens stored as sha256
      (`sessions.ts`), and login throttling (`login-throttle.ts`). Enforce
      strong passwords and `mustChangePassword` for seeded accounts.
- [ ] **Encrypted secret storage:** all dashboard-stored credentials and
      integration tokens/webhook secrets - including per-repo Slack webhook URLs
      - are AES-256-GCM encrypted with `CREDENTIAL_MASTER_KEY`. Set it in
      production; back it up securely.
- [ ] **HTTPS enforcement:** terminate TLS at the proxy/LB; only `443`/`22`
      public. Webhooks over HTTPS only.
- [ ] **Rate limiting:** per-org/provider rate-limit windows and budgets exist
      (`rate_limit_windows`, `Budget`). Configure budgets and alert thresholds.
      Add proxy-level rate limiting on `/webhooks/*` and auth routes if exposed
      broadly.
- [ ] **Secure webhook verification:** HMAC-SHA256 over raw body, constant-time
      compare, `401` on mismatch. Bitbucket rejects deliveries when no per-repo
      secret is configured (no unverified processing). GitHub App installation
      mutations require a delivery id and are protected by the
      `webhook_deliveries` replay ledger.
- [ ] **GitHub ownership binding:** the Hubolt organization slug must match the
      GitHub owner/account login for registered GitHub repos. PR deliveries are
      matched by repo full name plus installation id; installation ids are linked
      only from verified App installation events.
- [ ] **Least-privilege tokens:** GitHub App with only the permissions needed
      (pull requests: read/write, contents: read); Bitbucket token scoped to the
      target repos only. Prefer the GitHub App per-installation token over a
      shared PAT.
- [ ] **Database and backup security:** Postgres not exposed publicly; strong DB
      password; encrypted, access-controlled, off-box backups; restrict
      `prisma studio` to localhost/SSH tunnel.
- [ ] **Treat reviewed code as untrusted:** repo config (`.hubolt.yml`) is
      loaded from PR heads and is untrusted; integration secret env names are
      hardcoded so config cannot remap them (`src/integrations/env-names.ts`).
- [ ] **CORS locked down** in production (`CORS_ORIGIN`), helmet enabled.

---

## 10. Final deliverables

### Recommended production architecture (ASCII)

```
                       Internet (GitHub / Bitbucket / users)
                                      |
                                   HTTPS 443
                                      v
                    +---------------------------------+
                    |   Reverse proxy / Load balancer |   TLS termination
                    |   (nginx / Caddy / cloud LB)    |
                    +----------------+----------------+
                                     | proxy_pass 127.0.0.1:3000
                                     v
                    +---------------------------------+
                    |   Hubolt API server (Fastify)   |   systemd: hubolt-server
                    |   - REST API + dashboard (web/) |   node dist/server/index.js
                    |   - /webhooks/github  (enqueue) |
                    |   - /webhooks/bitbucket (inline)|
                    +----+-----------------+----------+
                         |                 |
              enqueue job|                 | read/write
                         v                 v
            +-------------------+   +-------------------+
            |   Redis (BullMQ)  |   |   PostgreSQL      |
            |   hubolt-review-  |   |   orgs, reviews,  |
            |   jobs queue +    |   |   findings, users,|
            |   gateway cache   |   |   audit, secrets  |
            +---------+---------+   +---------+---------+
                      |                       ^
              consume | jobs                  | persist reviews/findings
                      v                       |
            +-----------------------------+   |
            |  Hubolt review worker       |---+   systemd: hubolt-worker
            |  node dist/cli/index.js     |       (fetch PR diff, run LLM,
            |  worker start               |        post comments)
            +-----------------------------+
                      |
                      v
            LLM providers (Anthropic / OpenAI / Google)

Backups: daily pg_dump -> off-box, encrypted, retained.
Scale-out: run multiple workers on the same Redis queue;
move Postgres/Redis to managed services; multiple API instances behind the LB.
```

### Deployment checklist

- [ ] Server provisioned (Node >= 20.19, Postgres 16, Redis 7).
- [ ] Database and user created; `DATABASE_URL` set.
- [ ] `SHADOW_DATABASE_URL` set in CI/local drift-check environments.
- [ ] `REDIS_URL` set and Redis reachable.
- [ ] `.env` filled, `chmod 600`, never committed.
- [ ] `CREDENTIAL_MASTER_KEY` generated (`openssl rand -base64 32`) and backed up.
- [ ] At least one LLM provider key set.
- [ ] `npm ci && npm run build` succeeds.
- [ ] `npx prisma migrate deploy` applied; `db:check-drift` clean.
- [ ] `hubolt-server` service enabled and active; `/health` returns 200.
- [ ] `hubolt-worker` service enabled and active (if using GitHub webhooks).
- [ ] Reverse proxy + TLS configured; firewall allows only 443/22.
- [ ] DNS points at the proxy/LB.
- [ ] GitHub and/or Bitbucket webhooks configured with matching secrets.
- [ ] For GitHub App repos, Hubolt org slug matches the GitHub owner login and
      the installation event has linked the repo.
- [ ] CI green; deploy step (Bitbucket Pipelines or GitHub Actions) working.
- [ ] Backups scheduled; uptime/health monitoring in place.

### Sample `.env.production` (placeholders only)

```dotenv
# --- Runtime ---
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
# CORS_ORIGIN=https://hubolt.your-domain.com
# TRUST_PROXY=true

# --- Database ---
DATABASE_URL=postgresql://hubolt:CHANGE_ME_STRONG_PASSWORD@localhost:5432/hubolt_db
# For npm run db:check-drift only; must be a separate throwaway DB.
# SHADOW_DATABASE_URL=postgresql://hubolt:CHANGE_ME_STRONG_PASSWORD@localhost:5432/hubolt_shadow

# --- Redis (queue + gateway cache) ---
REDIS_URL=redis://localhost:6379

# --- Secret encryption (openssl rand -base64 32) ---
CREDENTIAL_MASTER_KEY=CHANGE_ME_BASE64_32_BYTES

# --- LLM providers (set at least one) ---
HUBOLT_LLM_PROVIDER=
HUBOLT_LLM_MODEL=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=

# --- GitHub App (for the GitHub webhook + posting reviews) ---
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY=
# Standalone repo webhook secret (alternative/in addition to the App secret)
GITHUB_WEBHOOK_SECRET=
# Fallback PAT if no GitHub App is configured
# GITHUB_TOKEN=

# --- Worker / cache ---
HUBOLT_REVIEW_CONCURRENCY=2
HUBOLT_CACHE_DIR=/opt/hubolt/.cache

# --- Notifications / issue trackers (optional) ---
HUBOLT_SLACK_WEBHOOK_URL=
HUBOLT_TEAMS_WEBHOOK_URL=
# HUBOLT_JIRA_BASE_URL=
# HUBOLT_JIRA_EMAIL=
# HUBOLT_JIRA_TOKEN=
# HUBOLT_CLICKUP_TOKEN=
# HUBOLT_ASANA_TOKEN=
```

### Go-live checklist (verify the running system)

```bash
# Server
curl -fsS https://your.domain.com/health     # status ok, database.connected true
curl -fsS https://your.domain.com/ready       # ready: true
systemctl status hubolt-server --no-pager

# Worker (GitHub flow)
systemctl status hubolt-worker --no-pager
journalctl -u hubolt-worker -n 50 --no-pager  # "Hubolt review worker started"

# Database
set -a; . /opt/hubolt/.env; set +a
npx prisma migrate status                      # migrations applied, no pending

# Queue / Redis
redis-cli ping                                 # PONG
redis-cli LLEN bull:hubolt-review-jobs:failed  # ideally 0

# Webhooks (end to end)
# 1. Open or update a PR on a registered repo.
# 2. Confirm a 2xx delivery in the GitHub/Bitbucket webhook log.
# 3. Watch worker logs: "Review job ... <n> finding(s)" (GitHub),
#    or server logs: "Bitbucket review finished" (Bitbucket).
# 4. Confirm review comments appear on the PR and a Review row is persisted.
```

---

Build and run summary:

```bash
npm ci && npm run build            # compile to dist/
npm run db:migrate                 # apply migrations
node dist/server/index.js          # API server (or: npm run server)
node dist/cli/index.js worker start  # review worker (GitHub flow)
```
