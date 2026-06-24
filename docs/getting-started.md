# Getting Started

This guide takes you from a fresh clone to a working local review and (optionally)
a running server. Commands assume macOS or Linux with a POSIX shell.

Related: [Configuration](configuration.md) | [Development](development.md) |
[Database](database.md) | [Troubleshooting](troubleshooting.md)

## Prerequisites and supported versions

| Tool | Version | Why |
|------|---------|-----|
| Node.js | >= 20.19 (enforced by `engines`) | Runtime for CLI and server |
| npm | Bundled with Node | Package manager (repo uses `package-lock.json`) |
| Git | Any recent | Hubolt reviews git diffs |
| PostgreSQL | 16 | Server storage and migrations (dev compose uses `postgres:16-alpine`) |
| Redis | 7 | Optional; enables the LLM gateway and queue |
| Docker + Docker Compose | Optional | Easiest way to run Postgres + Redis locally |

You do not need Postgres or Redis for local CLI review (`hubolt review`). They are
only required to run the server.

## Required accounts and keys

- At least one LLM provider key to run an LLM review:
  - `OPENAI_API_KEY` (OpenAI), `ANTHROPIC_API_KEY` (Claude), or
    `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini).
- Optional, for GitHub features: a `GITHUB_TOKEN` (or `GH_TOKEN`) to post PR
  comments, or a GitHub App (`GITHUB_APP_*`) for webhooks.

See [Configuration](configuration.md) for every variable.

## 1. Clone and install dependencies

```bash
git clone https://github.com/m-rithik/hubolt.git
cd hubolt
npm install
```

`npm install` triggers `prisma generate` during the build lifecycle; if you only
run `npm install` you can generate the client explicitly with `npx prisma generate`.

## 2. Configure environment

Create a `.env` for machine secrets and a `.env.local` for your database URL
(both are git-ignored). The server loads `.env.local` first, then `.env`.

```bash
# .env  (provider keys, server secrets)
OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
HUBOLT_LLM_PROVIDER=openai
HUBOLT_LLM_MODEL=gpt-4o-mini
REDIS_URL=redis://localhost:6379

# .env.local  (database connection)
DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db"
```

A complete, annotated list is in [Configuration](configuration.md). A ready-to-copy
server template lives at [`deploy/env.example`](../deploy/env.example).

## 3. Run a local CLI review (no database needed)

From the source tree, the CLI runs through `tsx`:

```bash
npm run dev -- review --staged          # review staged changes
npm run dev -- review                    # review all working-tree changes
npm run dev -- analyze                   # analyzers only, no LLM, no key needed
npm run dev -- review --json report.json --md report.md
```

`npm run dev -- <args>` forwards everything after `--` to the `hubolt` CLI
(`src/cli/index.ts`). See [Features](features.md) for the full command set.

## 4. (Optional) Run the server

Start Postgres + Redis, apply migrations, then start the server.

Option A - Docker Compose (repo default):

```bash
npm run db:start          # docker-compose up -d  (postgres + redis)
npm run db:migrate        # prisma migrate deploy
npm run dev:server        # server on http://127.0.0.1:3000
```

Option B - native (no Docker), macOS with Homebrew:

```bash
brew install postgresql@16 redis
brew services start postgresql@16 redis
/opt/homebrew/opt/postgresql@16/bin/createuser -s hubolt 2>/dev/null || true
/opt/homebrew/opt/postgresql@16/bin/psql -d postgres \
  -c "ALTER ROLE hubolt WITH LOGIN PASSWORD 'hubolt_dev' CREATEDB;" \
  -c "CREATE DATABASE hubolt_db OWNER hubolt;" 2>/dev/null || true
npm run db:migrate
npm run dev:server
```

Create the first organization, admin user, and API key:

```bash
npm run dev -- server bootstrap --org local --email you@example.com --no-save-env
```

This prints an API key once (stored hashed). Save it; you cannot retrieve it again.

## 5. First successful run - verification checklist

- [ ] `node --version` prints >= 20.19.
- [ ] `npm run typecheck` passes.
- [ ] `npm run dev -- analyze` runs and prints analyzer output (no key required).
- [ ] `npm run dev -- providers list` shows your provider with a key present.
- [ ] `npm run dev -- review --staged` produces findings or a clean result.
- [ ] (Server) `curl -fsS http://127.0.0.1:3000/health` returns
      `{"status":"ok",...,"database":{"connected":true,...}}`.
- [ ] (Server) `curl http://127.0.0.1:3000/ui` returns the control panel HTML.

If any step fails, see [Troubleshooting](troubleshooting.md).

## A note on global install

The README shows `npm install -g @m-rithik/hubolt`, but `package.json` declares
the package name as `hubolt-ass`. Until that is reconciled, the reliable path is
running from source with `npm run dev -- <command>` (or `npm run build` then
`node dist/cli/index.js <command>`). Needs maintainer confirmation of the
published npm package name.
