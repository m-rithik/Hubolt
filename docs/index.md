# Hubolt Documentation

Hubolt is a context-aware AI code review assistant that is local-first, not
local-only. It runs as a command-line tool for individual developers and as a
self-hostable middleware server for teams that need shared review history,
budgets, audit logs, and integrations.

This documentation describes what is actually implemented in this repository.
Where something is partial, inferred, or needs maintainer confirmation, it is
marked with a "Needs confirmation" note.

## What the project does

- Reviews code changes (staged, working-tree, file, or commit range) by combining
  static analyzer evidence with an LLM, then produces ranked, evidence-based
  findings.
- Outputs Markdown and JSON reports, and can post results to GitHub pull requests.
- Optionally runs a Fastify server that stores reviews, findings, feedback, audit
  events, budgets, and rate limits in PostgreSQL, with an LLM gateway backed by
  Redis/BullMQ.

## Core features (implemented)

- Local CLI review and a security-focused review mode.
- Static analyzers only mode (no LLM).
- LLM providers: OpenAI, Anthropic (Claude), Google (Gemini) via the Vercel AI SDK.
- Repository configuration through `.hubolt.yml`.
- Self-hostable server with REST API, API-key auth, and a web control panel at `/ui`.
- LLM gateway with per-provider budgets, rate limits, model routing, and audit logs.
- GitHub integration: post PR comments and suggestion blocks; receive webhooks.
- Local event log and team memory cards.
- Integration adapters (Slack, Teams, Jira, ClickUp, Asana) configured via `.hubolt.yml`.

Needs confirmation: the README lists Ollama / local-model support, but no Ollama
adapter dependency is present in `package.json`. Treat Ollama as not yet available.

## Intended users

- Individual developers and OSS maintainers who want fast local PR review.
- Teams that want a shared, auditable review service with one gateway API key
  instead of distributing model-provider keys across repositories.

## Architecture overview

```text
CLI (commander)                Server (Fastify)
  hubolt review            ->    REST API + /ui control panel
  hubolt security                  |
  hubolt analyze                   |-- PostgreSQL (Prisma + pg)
       |                           |-- Redis + BullMQ (queue, gateway)
       v                           |-- LLM Gateway (OpenAI/Anthropic/Google)
  Core review pipeline             |-- GitHub App webhooks
  - load changed files
  - build semantic context (tree-sitter)
  - run analyzers
  - call LLM provider
  - validate, rank, dedupe findings
       |
       v
  Reports / PR comments / push to server
```

Source layout: CLI in `src/cli`, server in `src/server`, review core in
`src/core`, providers in `src/providers`, queue in `src/queue`. See
[Project Structure](project-structure.md).

## Documentation navigation

Recommended reading order for a new user:

1. [Getting Started](getting-started.md) - install, configure, first run.
2. [Configuration](configuration.md) - every environment variable and `.hubolt.yml`.
3. [Project Structure](project-structure.md) - where everything lives.
4. [Development](development.md) - scripts, dev server, tests, debugging.
5. [Features](features.md) - what each module does.
6. [API & Integrations](api.md) - server endpoints and third-party services.
7. [Database](database.md) - schema, migrations, reset, backup.
8. [Testing](testing.md) - how to run and write tests.
9. [Deployment](deployment.md) - production and CI/CD.
10. [Troubleshooting](troubleshooting.md) - common failures and fixes.
11. [FAQ](faq.md) - quick answers.
12. [Security](security.md) - secrets, auth, reporting issues.
13. [Contributing](../CONTRIBUTING.md) - contribution workflow.

Historical phase and fix notes live in [develop-log/](develop-log/).
