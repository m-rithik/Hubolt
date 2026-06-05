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
