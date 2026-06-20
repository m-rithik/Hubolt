# Hubolt Server Setup

Phase 4 introduces the Hubolt middleware server for centralized review storage, history, audit logs, budgets, and optional hosted LLM gateway.

## Database Setup

### Prerequisites

- Docker and Docker Compose
- Node.js 20+

### Start Postgres Locally

```bash
docker-compose up -d
```

This starts a Postgres 16 container with credentials:
- User: `hubolt`
- Password: configured by `POSTGRES_PASSWORD` in `docker-compose.yml`
- Database: `hubolt_db`
- Port: `5432`

Verify it's running:

```bash
docker-compose ps
```

### Run Migrations

Initialize the database schema:

```bash
npx prisma migrate deploy
```

This runs all migrations in `prisma/migrations/`. After the first run, you can also use `prisma migrate dev` to create new migrations interactively.

### Inspect the Database

View tables and data:

```bash
npx prisma studio
```

This opens an interactive database UI at `http://localhost:5555`.

## Local API Key Setup

Create the first organization, admin user, and API key:

```bash
DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db" \
hubolt server bootstrap
```

The guided setup asks for the org, admin email, key name, server URL, and whether to save the generated key to `.env`.

For scripts, pass values directly:

```bash
DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db" \
hubolt server bootstrap --org rithik --email you@example.com --save-env
```

When saved, the command stores the local server settings outside tracked repository files, in `.env` by default:

```bash
HUBOLT_SERVER_URL="http://127.0.0.1:3000"
# HUBOLT_API_KEY is written by hubolt server bootstrap.
```

Use `--no-save-env` if you only want the key printed, or `--env-file <path>` if you want to write another ignored local env file. In non-interactive mode, pass either `--save-env` or `--no-save-env` explicitly.

Then push reports without passing the key on every command:

```bash
hubolt push-report --report report.json
```

For local development, `.env` and `.env.*` files are ignored by git. Do not store middleware API keys in `.hubolt.yml`, README files, or committed scripts.

## Schema Overview

### Core entities:

- **Organizations** — teams/orgs that group repos, members, and budgets
- **Users** — developers with email-based identity
- **OrganizationMembers** — join table with roles (viewer, reviewer, admin)
- **ApiKeys** — org-scoped API keys for CLI/CI authentication
- **Repositories** — git repos under an org
- **Reviews** — stored review results with findings and model usage
- **Findings** — individual findings from a review
- **AnalyzerSignals** — signals from static analyzers (TypeScript, ESLint, Semgrep, etc.)
- **ModelUsage** — token usage and cost tracking per review
- **Budgets** — monthly LLM budget limits per org/provider
- **AuditEvents** — audit trail of actions
- **RateLimitWindows** — request rate limiting per org/provider/model

## GitHub App (automated PR review)

The dashboard's **GitHub Repos** tab lets an admin register repositories; Hubolt
then reviews every pull request on them (inline comments, a summary, and a
merge-conflict note) and records the results. Authentication is via a GitHub
App, so no per-repo token is stored.

### One-time: create the App

Create a GitHub App (Settings -> Developer settings -> GitHub Apps) with:

- **Permissions:** Pull requests: Read & write; Contents: Read-only; Metadata: Read-only.
- **Subscribe to events:** Pull request (optionally Installation, Installation repositories).
- **Webhook URL:** `https://<your-server>/webhooks/github`
- **Webhook secret:** a random string (used below).
- Generate and download a **private key** (PEM).

### Server environment

Set these for both `hubolt server` and `hubolt worker start`:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="<paste the .pem contents on one line, real newlines escaped as \n>"
GITHUB_APP_SLUG=your-app-slug          # used to build the install link in the UI
GITHUB_APP_WEBHOOK_SECRET=...          # matches the App's webhook secret
```

`GITHUB_APP_PRIVATE_KEY` accepts a PEM with literal `\n` escapes (single-line
env var). Webhook ingest also requires `REDIS_URL`; the worker requires
`CREDENTIAL_MASTER_KEY` and an LLM provider key as usual. If the App is not
configured, the worker falls back to `GITHUB_TOKEN`/`GH_TOKEN` for a single
shared token.

### Use it

1. In the dashboard, open **GitHub Repos** and paste a repo link (e.g.
   `https://github.com/owner/repo`).
2. Click **Install GitHub App** and install it on those repos.
3. Open a pull request; Hubolt posts the review and records it under **Reviews**.

## Cleanup

Stop the database:

```bash
docker-compose down
```

Remove the database volume (deletes all data):

```bash
docker-compose down -v
```

## Troubleshooting

### "Cannot connect to the Docker daemon"

Ensure Docker is running:

```bash
open /Applications/Docker.app
```

### Prisma can't connect

Check `.env.local`:

```bash
cat .env.local
# Should show: DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db"
```

Verify Postgres is running:

```bash
docker-compose ps
```

### Reset schema

Drop and recreate the database:

```bash
npx prisma migrate reset
```

This destroys all data and re-runs all migrations.
