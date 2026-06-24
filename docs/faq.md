# FAQ

Related: [Getting Started](getting-started.md) | [Features](features.md) |
[Troubleshooting](troubleshooting.md)

**What is Hubolt?**
A context-aware AI code review assistant. It reviews git changes using static
analyzers plus an LLM and produces ranked, evidence-based findings. It runs as a
CLI and as an optional self-hosted server.

**Do I need a database to use it?**
No. Local CLI review (`hubolt review`, `hubolt analyze`) needs no database. The
server needs PostgreSQL.

**Do I need Redis?**
Only for the LLM gateway and the background queue. The server runs without it,
with those features disabled.

**Which LLM providers are supported?**
OpenAI, Anthropic (Claude), and Google (Gemini), via the Vercel AI SDK. The README
mentions Ollama, but there is no Ollama adapter dependency yet - treat it as not
available (needs maintainer confirmation).

**Which package manager does the project use?**
npm (there is a `package-lock.json`). Use `npm ci` in CI and `npm install` locally.

**How do I run a command without installing globally?**
`npm run dev -- <command>` runs the CLI from source. Example:
`npm run dev -- review --staged`.

**Can I `npm install -g` the CLI?**
The README shows `@m-rithik/hubolt`, but `package.json` names the package
`hubolt-ass`. Until that is reconciled, run from source or `npm run build` then
`node dist/cli/index.js`. (Needs maintainer confirmation.)

**How do I create an API key for the server?**
`hubolt server bootstrap --org <slug> --email <you> --no-save-env`. The key is
printed once and stored only as a hash - save it immediately.

**I lost my API key. Can I recover it?**
No. Keys are stored hashed. Create a new one (revoke the old via
`DELETE /orgs/current/api-keys/:keyId`).

**What is the difference between admin and viewer keys?**
Viewer keys can read; admin keys can also perform state-changing actions
(create/update/delete). State-changing routes call `requireAdmin`.

**How do I review only staged changes before committing?**
`npm run dev -- review --staged`.

**How do I gate CI on findings?**
`hubolt review --ci --fail-on high` (or `hubolt security --ci --fail-on high`)
exits non-zero when findings meet the severity.

**Where are local logs and cache stored?**
Under `.hubolt/` (event log at `.hubolt/logs/events.jsonl`); cache location is
shown by `hubolt cache status` and can be set with `HUBOLT_CACHE_DIR`.

**How do I deploy to a server?**
See [Deployment](deployment.md) and the detailed [`deploy/README.md`](../deploy/README.md)
(no-Docker server with Bitbucket Pipelines).

**Where did the old phase/fix docs go?**
Into [`docs/develop-log/`](develop-log/). They are historical development notes.

**How do I contribute?**
See [Contributing](../CONTRIBUTING.md). Run `npm run typecheck && npm test` first.
