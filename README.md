<div align="center">

# Hubolt 

**Context-aware AI code review that is local-first, not local-only.**

Hubolt reviews your git changes by combining static-analyzer evidence with an LLM,
then produces ranked, evidence-based findings.
Run it as a CLI for yourself, or as a self-hostable server for your team.

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/m-rithik/Hubolt)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-339933.svg?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6.svg?logo=typescript&logoColor=white)](tsconfig.json)
[![Stars](https://img.shields.io/github/stars/m-rithik/hubolt?style=social)](https://github.com/m-rithik/hubolt/stargazers)



[Documentation](docs/index.md) &nbsp;·&nbsp;
[Getting Started](docs/getting-started.md) &nbsp;·&nbsp;
[Hosted server](#hosted-team-server) &nbsp;·&nbsp;
[Features](docs/features.md) &nbsp;·&nbsp;
[API](docs/api.md) &nbsp;·&nbsp;
[Deployment](docs/deployment.md)

</div>

---

## Why Hubolt

Most AI review tools comment on a raw diff. That misses upstream validation, shared
type contracts, repository conventions, and cross-file effects, so the output is
noisy and developers learn to ignore it. Hubolt builds real context before it
reviews, and stays quiet when there is nothing worth saying.

**What makes it different**




- **Context-aware, not diff-only.** Pulls in changed files, semantic regions
  (tree-sitter), and analyzer signals before calling the model.
- **Evidence over opinions.** Each finding explains what, why it matters, and how
  to verify the fix, with a severity and confidence.
- **Low noise by design.** Comment budgets, severity thresholds, ranking, and
  dedupe keep reviews short and signal-heavy.
- **Local-first, not local-only.** Start as a single-developer CLI; grow into a
  shared team server without changing the review core.
- **Safe by default.** Reviewed code is treated as untrusted input, secrets are
  redacted before prompts, and fixes are suggested for human review, never applied
  silently.

**Who it's for**

| You are... | Use Hubolt as... |
|------------|------------------|
| An individual developer | A pre-commit / pre-PR CLI (`review --staged`). |
| An OSS maintainer | A GitHub Action that comments on pull requests. |
| A team / org | A self-hosted server with shared history, budgets, audit logs, and a single gateway key. |

## How it works

```text
 git changes ──▶ context (tree-sitter) ──▶ analyzers ──▶ LLM ──▶ rank + dedupe ──▶ findings
                                                                                     │
                                          reports · GitHub PR comments · team server ◀┘
```

1. Collect the diff (staged, working tree, a file, or a `--base`/`--head` range).
2. Build context: changed files, semantic regions, and related snippets.
3. Run static analyzers (TypeScript, ESLint, semgrep, secret/dependency scans).
4. Call the configured LLM provider and validate structured findings.
5. Rank, dedupe, and filter to a comment budget.
6. Emit reports, PR comments, or push to a team server.

## Local vs hosted

Both lanes share the same review core. Start local, grow into the hosted server
when your team needs shared history and governance - nothing about the review
itself changes.

| | Local / CLI | Hosted / Team server |
|---|---|---|
| **Run as** | CLI or GitHub Action | self-hosted Fastify server |
| **Storage** | local `.hubolt/` (event log + cache) | PostgreSQL |
| **Needs Postgres/Redis** | No | Postgres required; Redis for gateway + queue |
| **Provider keys** | each user / CI sets their own | one gateway key; credentials stored encrypted |
| **Review history** | local report files | shared history, trends, audit log |
| **GitHub bot** | Action or `github post` with a token | GitHub App webhooks processed by a worker |
| **Governance** | config thresholds + comment budget | per-provider budgets, rate limits, model routing, admin/viewer keys |
| **Extras** | Markdown / JSON reports | web control panel at `/ui`, Slack / Teams / Jira / ClickUp / Asana |
| **Best for** | individuals, OSS, privacy-sensitive repos | teams needing shared, auditable review |

### The GitHub bot, in both lanes

- **Local / CI:** the GitHub Action (or `hubolt github post`) runs the review on a
  pull request and posts the summary, inline comments, and suggestion blocks using
  a `GITHUB_TOKEN`. No server required.
- **Hosted:** a GitHub App sends webhooks to `POST /webhooks/github`; the server
  queues each event and a background `worker` runs the review and comments back.
  This gives one install across many repos, plus shared history and budgets.

See [Hosted (team server)](#hosted-team-server) for setup, or
[Deployment](docs/deployment.md) for the full GitHub App walkthrough.

## Features at a glance

| | |
|---|---|
| **Review modes** | Local CLI review, security-focused mode, analyzers-only (no LLM). |
| **LLM providers** | OpenAI, Anthropic (Claude), Google (Gemini). |
| **Output** | Markdown / JSON reports; GitHub PR comments and suggestion blocks. |
| **Team server** | REST API, web control panel (`/ui`), review history, audit logs, budgets, rate limits, LLM gateway. |
| **Config** | Repository rules via `.hubolt.yml`. |
| **Integrations** | Slack, Teams, Jira, ClickUp, Asana. |

### A closer look

- **Review modes** - `review` for general feedback, `security` to fail on
  high-severity issues, `analyze` for analyzer-only runs that need no API key.
- **CI gating** - `--ci --fail-on <severity>` exits non-zero so a pull request
  can block on findings; `--json` / `--md` write report artifacts.
- **Memory** - a local event log plus compact team memory cards give the reviewer
  context without replaying full history into every prompt.
- **Governance (server)** - per-provider budgets, rate limits, model routing, and
  an audit trail of prompt version, model, tokens, and cost.
- **Control panel** - a built-in web UI at `/ui` for browsing reviews and config.

### Example finding (illustrative)

```text
File:       src/api/users.ts   (lines 24-27)
Severity:   medium      Confidence: high      Category: performance

Title:      Unbounded user query can load the entire collection.
Evidence:   The handler calls User.find() with no limit, cursor, or pagination
            guard and returns the result directly to the client.
Impact:     Large datasets increase memory use and slow the endpoint under load.
Fix:        Validate limit/offset and pass them into the query.
Verify:     Add a request test asserting the default limit and a valid page param.
```

For small, single-location fixes Hubolt prefers a GitHub suggestion block:

````text
```suggestion
const users = await User.find().limit(limit).skip(offset);
```
````

## Quick start (local)

> Requires **Node.js >= 20.19** and **npm**.

```bash
git clone https://github.com/m-rithik/hubolt.git
cd hubolt
npm install

# Local review from source (no database needed)
npm run dev -- analyze                 # analyzers only, no API key
npm run dev -- review --staged         # full review (set a provider key first)
```

Set a provider key in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`GOOGLE_GENERATIVE_AI_API_KEY`). See [Getting Started](docs/getting-started.md).

## Hosted (team server)

When a team needs shared review history, governance, and one place to manage model
keys, run the self-hostable server. It is a Fastify app backed by PostgreSQL, with
Redis enabling the LLM gateway and the background review queue. Full guide:
[Deployment](docs/deployment.md).

### 1. Run the server

```bash
npm run db:start && npm run db:migrate     # Postgres + Redis, then migrations
npm run dev:server                          # http://127.0.0.1:3000
```

Create your first organization, admin user, and API key (the key is printed once):

```bash
npm run dev -- server bootstrap --org local --email you@example.com --no-save-env
```

The server also ships a web control panel at `http://127.0.0.1:3000/ui`.

### 2. LLM gateway (one key for the team)

The gateway routes all model calls through a single Hubolt API key instead of
distributing provider keys to every repo. It adds per-provider budgets, rate
limits, model routing, and audit logs, and requires **Redis** (the `/gateway/*`
routes register only when the server connects to Redis).

```bash
# Encrypt stored provider credentials (set once, keep stable)
export CREDENTIAL_MASTER_KEY=$(openssl rand -base64 32)   # add to the server .env

# Add a provider credential via /ui, or via the API:
curl -X POST http://127.0.0.1:3000/gateway/credentials \
  -H "Authorization: Bearer <YOUR_HUBOLT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","apiKey":"<YOUR_OPENAI_API_KEY>"}'

# Verify health, model catalog, budgets, and audit logging
npm run dev -- gateway test
```

More: [API & Integrations](docs/api.md), [Configuration](docs/configuration.md).

### 3. GitHub bot (hosted, via webhooks)

Create a GitHub App, install it on your repos, and point its webhook at
`POST /webhooks/github` on your server. Set these on the server (never commit them):

| Variable | Purpose |
|----------|---------|
| `GITHUB_APP_ID` | App id |
| `GITHUB_APP_SLUG` | App slug |
| `GITHUB_APP_PRIVATE_KEY` | App private key (PEM) |
| `GITHUB_APP_WEBHOOK_SECRET` | Verifies inbound webhook signatures |

The server queues each event and a worker runs the review and comments back:

```bash
npm run dev -- worker      # background review workers (needs Redis)
```

Prefer no server? The [GitHub Action](.github/workflows/hubolt.yml) (or
`hubolt github post` with a `GITHUB_TOKEN`) posts PR comments without one.

## CLI quick reference

Shown as `hubolt <command>`. From a source checkout, prefix with
`npm run dev --` (e.g. `npm run dev -- review --staged`).

| Command | What it does |
|---------|--------------|
| `hubolt review` | Review working-tree changes (`--staged` for staged only). |
| `hubolt review --base main --head feature` | Review a commit range. |
| `hubolt security --fail-on high` | Security-focused review with a severity gate. |
| `hubolt analyze` | Static analyzers only, no LLM, no API key. |
| `hubolt setup` | Pick a provider and save the key to `.env`. |
| `hubolt config validate` | Validate `.hubolt.yml` and credentials. |
| `hubolt providers list` | List providers and whether a key is present. |
| `hubolt cache status` | Show review cache location and size. |
| `hubolt logs tail` | Tail the local review event log. |
| `hubolt server bootstrap` | Create the first org, admin, and API key. |
| `hubolt push-report --report report.json` | Push a review to a team server. |
| `hubolt gateway test` | Verify the LLM gateway. |
| `hubolt worker` | Run background review workers (needs Redis). |

Common review options: `--provider`, `--model`, `--no-llm`, `--no-cache`,
`--json <path>`, `--md <path>`, `--ci`, `--fail-on <severity>`, `--config <path>`.
Full reference: [Features](docs/features.md).

## Documentation

| Guide | What it covers |
|-------|----------------|
| [Getting Started](docs/getting-started.md) | Install, configure, first run, verify. |
| [Configuration](docs/configuration.md) | Every env var and `.hubolt.yml`. |
| [Project Structure](docs/project-structure.md) | Where everything lives. |
| [Development](docs/development.md) | Scripts, dev server, debugging. |
| [Features](docs/features.md) | Every command and module. |
| [API & Integrations](docs/api.md) | Endpoints, auth, third-party services. |
| [Database](docs/database.md) | Schema, migrations, backup/reset. |
| [Testing](docs/testing.md) | Running and writing tests. |
| [Deployment](docs/deployment.md) | Production and CI/CD. |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and fixes. |
| [FAQ](docs/faq.md) | Quick answers. |
| [Security](docs/security.md) | Secrets, auth, reporting issues. |
| [Contributing](CONTRIBUTING.md) | How to contribute. |

Historical development notes are in [docs/develop-log/](docs/develop-log/).

## Support and community

- **Star the repo** if you find it useful: [github.com/m-rithik/hubolt](https://github.com/m-rithik/hubolt)
- **Found a bug or have an idea?** Open an [issue](https://github.com/m-rithik/hubolt/issues).
- **Want to contribute?** Start with [CONTRIBUTING.md](CONTRIBUTING.md) - providers, analyzers, integrations, and docs are all welcome.
- **Security report?** See [Security](docs/security.md) for how to report privately.

## License

[Apache-2.0](LICENSE). Contributions are accepted under the same license.

