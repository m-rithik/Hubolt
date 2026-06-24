# Features

What each major feature and CLI command does, with inputs, outputs, and
limitations. Commands are shown as `npm run dev -- <command>` (running from
source); a global `hubolt` binary behaves the same once installed.

Related: [API & Integrations](api.md) | [Configuration](configuration.md) |
[Database](database.md)

## Review pipeline (core)

The heart of Hubolt. Source: [`src/core/`](../src/core/).

- Input: a git diff (staged, working tree, a file, or a `--base`/`--head` range)
  plus `.hubolt.yml` settings.
- Steps: load changed files, build semantic context with tree-sitter, run
  analyzers, call the LLM provider, validate structured findings, then rank,
  dedupe, and filter for noise.
- Output: ranked findings with severity, evidence, impact, suggested fix, and
  verification; optional Markdown/JSON reports.
- Limitations: review quality depends on the configured model; files over
  `maxFileSizeKb` are skipped; context is bounded by `maxContextTokens`.

## CLI commands

### review / security

```bash
npm run dev -- review                      # all working-tree changes
npm run dev -- review --staged             # staged changes only
npm run dev -- review src/app.ts           # a specific file
npm run dev -- review --base main --head feature   # a commit range
npm run dev -- review --json report.json --md report.md
npm run dev -- security --fail-on high     # security-focused review
```

Common options: `--provider`, `--model`, `--no-llm`, `--no-cache`,
`--json <path>`, `--md <path>`, `--ci`, `--fail-on <severity>`, `--config <path>`.
`--ci` makes the run deterministic and sets exit codes for gating.
Source: [`src/cli/commands/review.ts`](../src/cli/commands/review.ts).

### analyze

Run static analyzers only - no LLM, no API key.

```bash
npm run dev -- analyze --staged --no-cache
```

Useful as a fast, free pre-check. Source: [`src/cli/commands/analyze.ts`](../src/cli/commands/analyze.ts).

### setup / config

```bash
npm run dev -- setup                       # interactive: pick provider, save key
npm run dev -- setup --print > .hubolt.yml # print a starter config
npm run dev -- config validate             # validate .hubolt.yml + credentials
npm run dev -- config show                 # show resolved config
```

`setup` writes provider key and model to `.env`. Source:
[`setup.ts`](../src/cli/commands/setup.ts), [`config.ts`](../src/cli/commands/config.ts).

### providers

```bash
npm run dev -- providers list              # providers, default model, key present?
npm run dev -- providers test openai       # tiny call to verify credentials
```

Supported adapters: OpenAI, Anthropic (Claude), Google (Gemini). Source:
[`src/providers/`](../src/providers/).

### cache

Local review-result cache to avoid re-reviewing unchanged code.

```bash
npm run dev -- cache status                # location, entry count, size
npm run dev -- cache clear
npm run dev -- cache save <dir>            # export cache (for CI persistence)
npm run dev -- cache restore <dir>
```

### logs

```bash
npm run dev -- logs tail                   # recent events from .hubolt/logs/events.jsonl
npm run dev -- logs inspect                # summarize the event log
```

### github

Post results to GitHub pull requests (needs `GITHUB_TOKEN`/`GH_TOKEN`).

```bash
npm run dev -- github post --report report.json   # summary + inline comments + suggestions
npm run dev -- github map-lines --report report.json  # debug diff line mapping
```

Source: [`src/github/`](../src/github/), [`github.ts`](../src/cli/commands/github.ts).

### eval

Run golden review fixtures and score precision, recall, and range accuracy.

```bash
npm run dev -- eval
```

Source: [`src/eval/`](../src/eval/).

### report / push-report / history

```bash
npm run dev -- report --json report.json --md out.md   # render a saved report
npm run dev -- push-report --report report.json        # push to a Hubolt server
npm run dev -- history                                  # show server review history
```

`push-report` and `history` need `HUBOLT_SERVER_URL` and `HUBOLT_API_KEY`.

### memory

Team memory cards for context without replaying full history.

```bash
npm run dev -- memory list
npm run dev -- memory inspect              # which cards a review would retrieve
npm run dev -- memory add                  # add a pinned maintainer style card
npm run dev -- memory rebuild              # regenerate cards from feedback
```

### feedback

```bash
npm run dev -- feedback import             # import accepted/dismissed/discussed feedback
```

Imports from a PR's reactions/replies or a JSONL file; feeds learning.

### integrations / issues

```bash
npm run dev -- integrations list
npm run dev -- integrations setup          # pick an integration, paste secret, enable
npm run dev -- integrations test <name>    # send a sample event
npm run dev -- issues create --report report.json   # create Jira/ClickUp/Asana issues
```

Source: [`src/integrations/`](../src/integrations/). See [API & Integrations](api.md).

### webhooks

```bash
npm run dev -- webhooks verify-fixture <path>   # verify a raw webhook body fixture
```

## Server (team middleware)

A Fastify server exposing a REST API, a web control panel at `/ui`, and an LLM
gateway. Source: [`src/server/`](../src/server/).

```bash
npm run dev -- server --port 3000
npm run dev -- server bootstrap --org local --email you@example.com --no-save-env
```

- Input: API requests authenticated with `Authorization: Bearer <api-key>`.
- Output: persisted reviews, findings, feedback, audit events, budgets, rate
  limits; gateway completions.
- Limitations: requires PostgreSQL; the gateway requires Redis (disabled if Redis
  is unreachable, but the rest of the server still runs).

See [API & Integrations](api.md) for endpoints and [Database](database.md) for
the data model.

## LLM gateway

Lets a team use one Hubolt API key instead of distributing provider keys. Adds
per-provider budgets, rate limits, model routing, and audit logs. Provider
credentials are encrypted at rest with `CREDENTIAL_MASTER_KEY`. Source:
[`src/server/services/llm-gateway.ts`](../src/server/services/llm-gateway.ts).

```bash
npm run dev -- gateway test                # verify health, models, budgets, audit
```

## Queue and worker

Pull request reviews can be processed asynchronously via BullMQ on Redis.

```bash
npm run dev -- worker                      # run background review workers
```

Source: [`src/queue/`](../src/queue/).

## Audit log

```bash
npm run dev -- audit export                # export audit events from a server
```

Records actions such as `server.bootstrap`, API-key changes, and gateway usage.
Source: [`src/server/routes/audit.ts`](../src/server/routes/audit.ts).
