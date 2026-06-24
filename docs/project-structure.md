# Project Structure

An annotated map of the repository so you know where things live and where to make
common changes.

Related: [Features](features.md) | [Development](development.md)

## Top-level

```text
hubolt/
  src/                  TypeScript source (CLI + server + review core)
  test/                 Vitest tests, mirroring src/
  prisma/               Prisma schema and SQL migrations
  web/                  Static assets for the /ui control panel
  docs/                 This documentation (and develop-log/ history)
  deploy/               No-Docker server deployment files (systemd, scripts)
  scripts/              Build helper scripts (postbuild)
  examples/             Example inputs used by docs/tests
  dist/                 Build output (generated; git-ignored)
  .github/              GitHub Actions workflows and the review composite action
  docker-compose.yml    Local Postgres + Redis for development
  bitbucket-pipelines.yml  Bitbucket CI/CD pipeline
  package.json          Scripts, dependencies, bin (hubolt)
  tsconfig*.json        TypeScript configs (base + build)
  prisma.config.ts      Prisma config; loads .env.local then .env
  .hubolt.example.yml   Starter repository review config
```

## `src/` layout

```text
src/
  index.ts            Library entry (exports)
  version.ts          Version constant used by the CLI
  cli/                Command-line interface
    index.ts          Registers all commands (commander)
    commands/         One file per command group (review, server, gateway, ...)
    help.ts, ui.ts    CLI help and rendering
    server-client.ts  HTTP client for talking to a Hubolt server
  server/             Fastify server (team middleware)
    index.ts          Server entrypoint (node dist/server/index.js)
    app.ts            Builds the Fastify app and registers routes
    db.ts             Prisma client (pg Pool + driver adapter)
    redis.ts          Redis client
    api-keys.ts       API key generation and hashing
    middleware/       auth.ts (Bearer + roles), error-handler.ts
    routes/           One file per route group (see API docs)
    services/         Gateway, budgets, credentials, model routing, memory, ...
    webhooks/         Webhook handling
  core/               Review pipeline (diff, context, analyze, rank, redact, cache)
  providers/          LLM provider adapters (OpenAI, Anthropic, Google)
  queue/              BullMQ jobs and worker
  github/             GitHub posting and PR helpers
  integrations/       External adapters (Slack, Teams, Jira, ClickUp, Asana)
  memory/             Memory cards and retrieval
  feedback/           Feedback import and learning
  report/             Report renderers (Markdown, JSON)
  eval/               Evaluation harness
  config/             Config loading, schema (zod), env handling
  generated/          Prisma client (generated; do not edit)
  types/              Shared types
```

## Where to make common changes

| You want to... | Edit here |
|----------------|-----------|
| Add or change a CLI command | `src/cli/commands/` and register it in `src/cli/index.ts` |
| Add a server endpoint | `src/server/routes/`, register in `src/server/app.ts` |
| Change review behavior | `src/core/` (pipeline, ranking, redaction) |
| Add an LLM provider | `src/providers/` |
| Add an integration adapter | `src/integrations/` |
| Change the data model | `prisma/schema.prisma` then create a migration (see [Database](database.md)) |
| Change default review config | `.hubolt.example.yml` and `src/config/schema.ts` |
| Edit the web control panel | `web/` and `src/server/routes/ui.ts` |

## Conventions

- ESM throughout (`"type": "module"`). Internal imports use the `.js` extension
  on relative paths even for `.ts` files (TypeScript ESM resolution), e.g.
  `import { createApp } from "./app.js"`.
- One command group per file in `src/cli/commands/`; one route group per file in
  `src/server/routes/`, each exporting a `register...` function.
- Tests live under `test/` mirroring the `src/` path of what they cover.
- Generated code in `src/generated/` is never edited by hand.
- No emojis in code, comments, or output (see [Contributing](../CONTRIBUTING.md)).
