# Hubolt - Context-Aware AI Code Review Assistant

Hubolt is a local-first, not local-only, AI code review assistant designed to produce high-signal pull request reviews. It combines codebase context, static analyzer evidence, and LLM reasoning so developers can start locally while teams can grow into shared middleware, logs, webhooks, and integrations.

The project is built around one idea: an AI reviewer is only valuable if it understands enough context to be trusted.

## Why Hubolt

Most AI review tools can comment on a diff. That is no longer enough. Diff-only review often misses upstream validation, shared type contracts, repository conventions, and cross-file effects. The result is noise: shallow suggestions, repeated comments, and feedback that developers eventually ignore.

Hubolt is planned around a sharper review model:

- Context-aware review that includes changed files, semantic regions, and related snippets.
- Analyzer-backed findings from tools such as TypeScript, ESLint, Semgrep, and secret scanning.
- Evidence-based comments that explain why a finding matters and how to verify the fix.
- Local-first operation for developers and privacy-sensitive repositories.
- Low-noise review modes, comment budgets, severity thresholds, and persistent dedupe.
- Safe fix suggestions through GitHub suggestion blocks and draft patches, not silent auto-edits.

## Core Features

- Local CLI review for staged changes, working tree diffs, and pull request branches.
- GitHub Action review for pull requests using the same core pipeline as the CLI.
- Self-hostable team middleware for shared review history, audit logs, budgets, and model routing.
- PR summary and walkthrough with changed areas, risk score, and top findings.
- Inline review comments with range-aware file locations.
- GitHub suggestion blocks for small, safe, single-location fixes.
- Markdown and JSON report artifacts for CI and local use.
- Repository configuration through `.hubolt.yml`.
- Natural-language custom rules for team-specific standards.
- Typed integration events from the first build so future adapters do not change the core pipeline.
- Local memory logs and compact review summaries for context without replaying full history.
- LLM provider support for OpenAI first, then Claude, Gemini, and Ollama.
- Hosted LLM gateway roadmap so teams can rely on one Hubolt API for model routing, audit logs, budgets, and shared review memory.
- Hosted tier roadmap for review history, feedback learning, dashboards, RBAC, and external integrations.

## Local-First, Not Local-Only

Hubolt starts as a fast local reviewer, then scales into team infrastructure without changing the review core.

| Lane | Who it is for | What it provides |
|---|---|---|
| Local and CI | Individual developers, OSS projects, privacy-sensitive repos, and fast pre-PR checks. | `hubolt review --staged`, security mode, local JSON/Markdown reports, redacted `.hubolt/` logs, and optional local-model review. |
| Team middleware | Teams that need shared history, governance, auditability, and integrations. | Self-hosted API, Postgres review history, hosted LLM gateway, org budgets, webhooks, PR comments, feedback learning, and Slack/Jira-style integrations. |

Local mode does not require a Hubolt server. Team mode adds centralized logs and workflow automation when a team is ready for it.

## Architecture

Hubolt uses one shared review core across every deployment path.

```text
Local CLI or GitHub Action
        |
        v
Review context builder
        |
        v
Core review pipeline
  - load changed files
  - build semantic context
  - run analyzer legos
  - call LLM provider
  - validate structured findings
  - rank, dedupe, and filter noise
        |
        v
Typed review events
        |
        v
Reports, PR comments, suggestion blocks, or hosted storage
```

The core pipeline is provider-agnostic. LLMs, analyzers, source control providers, storage backends, event sinks, notification providers, issue trackers, and report renderers are adapters around the same typed review model.

## Deployment Tiers

### Stateless Tier

The stateless tier is for individuals, open source projects, CI workflows, and privacy-sensitive repositories.

- Runs as a CLI or GitHub Action.
- Sends code directly from the runner to the configured model provider.
- Stores no hosted history.
- Can write local JSON and Markdown reports.
- Can use local models through Ollama when configured.

### Team Middleware Tier

The team middleware tier is planned for teams that need centralized review history, governance, audit logs, and workflow automation.

- Receives repository webhooks.
- Processes reviews through queued workers.
- Stores reviews, findings, feedback, and audit events.
- Learns from accepted and dismissed feedback.
- Acts as an optional LLM gateway so teams can use one Hubolt API key instead of distributing model-provider keys across every repository.
- Enforces org budgets, provider routing, rate limits, redaction, prompt versions, and model audit trails.
- Supports dashboards, RBAC, org memory, and trend reports.

Both lanes use the same core review pipeline.

## Planned Quickstart

Hubolt is currently in the planning and implementation stage. The intended developer workflow is:

```bash
npm install -g @m-rithik/hubolt
hubolt setup
hubolt review --staged
hubolt review --json hubolt.report.json --md hubolt.report.md
```

For GitHub Actions:

```yaml
name: Hubolt Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: m-rithik/hubolt/.github/actions/hubolt@main
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Configuration Preview

Hubolt is configured with repository rules plus machine-level secrets.

```yaml
# .hubolt.yml
mode: balanced
severityThreshold: medium
failOnSeverity: critical
commentBudget: 8
maxFileSizeKb: 256

providers:
  llm: openai
  model: gpt-4.1-mini

privacy:
  redactSecrets: true
  showContextSentToModel: true
  allowExternalModels: true

analyzers:
  typescript: true
  eslint: true
  semgrep: true
  secrets: true

memory:
  localEventLog: true
  summarizeAfterEvents: 50
  maxPromptMemoryTokens: 2500
  retrieval: lexical

behaviorPacks:
  - reviewer-discipline

integrations:
  events: true
  github: true
  slack: false
  jira: false

ignore:
  - dist/**
  - build/**
  - coverage/**
  - "**/*.test.ts"

knowledgeFiles:
  - README.md
  - .github/copilot-instructions.md
  - .hubolt/context.md

rules:
  - "API handlers must validate request bodies with zod before using them."
  - "React components should avoid unnecessary derived state."
  - "Database reads that can return large collections must include pagination or explicit limits."
```

Machine secrets stay outside the repository:

```bash
OPENAI_API_KEY=...
HUBOLT_LLM_PROVIDER=openai
HUBOLT_LLM_MODEL=gpt-4.1-mini
HUBOLT_REVIEW_CONCURRENCY=4
```

## Example Finding

```text
File: src/api/users.ts
Range: lines 24-27
Severity: medium
Confidence: high
Category: performance
Source: llm+analyzer

Title:
Unbounded user query can load the entire collection.

Evidence:
The changed handler calls User.find() without a limit, cursor, or pagination guard.
The route returns the result directly to the client.

Impact:
Large datasets can increase memory use, slow the endpoint, and make the API harder to operate under load.

Suggested fix:
Add limit and offset validation, then pass those values into the query.

Verification:
Add or update a request test that verifies the endpoint applies the default limit and respects a valid page parameter.
```

For small single-location fixes, Hubolt will prefer GitHub suggestion blocks:

```suggestion
const users = await User.find().limit(limit).skip(offset);
```

## Memory and Behavior

Hubolt should not paste an entire past conversation or review history into every prompt. That would be noisy, expensive, and rate-limit heavy. Instead it uses layered memory:

- Structured event logs for exact audit history.
- Compact Markdown memory cards for human-readable project and team context.
- A lightweight retrieval index for file-specific and rule-specific memory.
- Pinned memory for stable rules that should always be included.
- Retrieved memory for only the few past facts relevant to the current change.

Local stateless mode can keep memory under `.hubolt/`:

```text
.hubolt/
  logs/
    events.jsonl
  memory/
    repo.md
    feedback.md
    files/
      src-api-users.md
  index/
    lexical.sqlite
```

Hosted mode stores the same concepts in Postgres, with optional vector search later. Raw logs are used for audit and debugging; prompts receive compact summaries and retrieved memory cards.

Behavior packs are short review guidelines that shape how Hubolt reviews. The default pack should bias the reviewer toward explicit assumptions, simple recommendations, surgical comments, and verification steps. This follows the same spirit as Karpathy-style coding-agent guidelines while keeping Hubolt's own prompt small and review-specific.

## Roadmap

### MVP

- TypeScript CLI scaffold.
- `.hubolt.yml` configuration.
- Local JS/TS review with full-file context.
- Tree-sitter semantic regions for changed functions and classes.
- Typed review events and local event log.
- OpenAI provider through the Vercel AI SDK.
- Range-aware findings with evidence and verification.
- Markdown and JSON reports.
- TypeScript and ESLint analyzer legos.
- Security check mode.
- Evaluation harness with golden diff fixtures.

### V1

- GitHub Action integration.
- Semgrep and secret scanning signals.
- Persistent dedupe through finding fingerprints.
- CI-mode reporting and cache.
- Claude and Ollama provider support.
- Model cascade for cost-aware review.

### Team Middleware

- Postgres and Prisma review history.
- Hosted LLM gateway with org budgets, model routing, and audit logs.
- API ingestion for CLI and CI review events.
- Team history, audit export, and model usage reports.

### Webhooks and Feedback

- Fastify webhook service.
- BullMQ workers and Redis queue.
- PR summaries and inline comments.
- GitHub suggestion blocks.
- Incremental PR review and duplicate suppression.
- Feedback learning from accepted and dismissed comments.
- Org-level style memory.

### Enterprise Integrations

- RBAC, OAuth, audit logs, and team dashboards.
- GitLab, Bitbucket, Slack, Teams, Jira, ClickUp, and Asana integrations.

## Privacy and Security

Hubolt is designed to be explicit about code movement.

- Stateless mode does not send code through a Hubolt-hosted middleman.
- Local model support through Ollama is planned for repositories that cannot use hosted LLMs.
- Reports can show which files and snippets were included in model context.
- Local logs should be structured and redacted before storage.
- Hosted audit logs should record prompt version, model, token usage, cost, memory references, and output hashes.
- Secret redaction runs before prompt construction.
- Reviewed code, comments, commit messages, and repository files are treated as untrusted data.
- Prompts fence untrusted content so code cannot override review instructions.
- Fixes are suggested for human review; Hubolt does not silently apply patches.

## Contributing

Hubolt is intentionally modular. Useful contribution areas include:

- LLM providers.
- Analyzer providers.
- Source control providers.
- Report renderers.
- Evaluation fixtures.
- Prompt and ranking improvements.
- GitHub Action hardening.
- Documentation and examples.

The goal is a reviewer that developers keep enabled because it is accurate, explainable, and quiet when it should be quiet.
