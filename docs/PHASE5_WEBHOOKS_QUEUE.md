# Phase 5: Webhooks and Queue

Status: Complete; acceptance criteria verified against a live pull request
Date: 2026-06-12
Tests: 302 passing

Live verification (m-rithik/hubolt-sandbox PR 1, 2026-06-12): one summary
comment created and updated in place on rerun, inline comments anchored on
the correct changed lines (single-line at 15, multi-line 14-16), one
suggestion block on an added-line finding, an out-of-diff finding routed to
the summary, and a rerun skipping both posted fingerprints with zero
duplicate comments. Posting used `hubolt github post` with a schema-valid
report; no model calls were involved.

Connects the hosted middleware to repository events: GitHub webhook ingest
with signature verification, a queue-backed review worker that runs the core
pipeline, diff line mapping, PR comment posting with dedupe, suggestion
blocks, and incremental review on synchronize events.

## Flow

```
GitHub webhook (pull_request)
      |
POST /webhooks/github
  - HMAC SHA-256 signature check (timing-safe, raw bytes)
  - payload classification (zod)
  - repository lookup (must be registered)
  - enqueue, deduped by repo:pr:headSha
      |
BullMQ queue "hubolt-review-jobs"
      |
hubolt worker start
  - stale-head and already-reviewed skips
  - .hubolt.yml fetched from the PR head (defaults on failure)
  - hosted context from PR files + contents API
  - core review pipeline (same as local review)
  - review persisted (one row per reviewed head)
  - results posted to the PR
      |
GitHub PR
  - one stable summary comment, updated in place
  - inline comments with fingerprint markers (no reposts)
  - suggestion blocks for findings with fixPatch on added-only ranges
```

## Modules

| Module | Responsibility |
|---|---|
| `src/server/webhooks/signature.ts` | HMAC signature compute/verify |
| `src/server/webhooks/payload.ts` | Event classification (review / ignored / invalid) |
| `src/server/routes/webhooks.ts` | Ingest route; raw-body parsing scoped to this route |
| `src/queue/review-jobs.ts` | Job contract and producer with redelivery dedupe |
| `src/queue/review-context.ts` | BuiltContext from PR files fetched over the API |
| `src/queue/review-processor.ts` | Job processing, incremental logic, persistence |
| `src/queue/worker.ts` | BullMQ worker runtime |
| `src/providers/scm/scm.interface.ts` | SCM boundary used by all GitHub-posting code |
| `src/providers/scm/github/client.ts` | GitHub REST adapter (built-in fetch, no octokit) |
| `src/github/line-mapping.ts` | Patch hunk index; finding range to comment mapping |
| `src/github/comments.ts` | Summary and inline bodies, markers, dedupe reading |
| `src/github/suggestions.ts` | Suggestion block eligibility and rendering |
| `src/github/post.ts` | Posting orchestration |

Note on the plan: plan.md lists @octokit/rest as the GitHub client. The
adapter uses Node's built-in fetch instead; the few endpoints needed did not
justify the dependency surface, and the ScmProvider interface keeps the
choice swappable.

## Behavior details

- Webhook responses: 401 invalid signature, 400 unparseable payload, 202 for
  everything else (including skipped events) so GitHub does not retry.
- Only `pull_request` actions opened, synchronize, reopened, and
  ready_for_review enqueue jobs; drafts are skipped.
- Job ids are `repoId:prNumber:headSha`, so redeliveries and concurrent
  deliveries of the same head collapse into one job.
- The worker skips a job when the PR head has moved past it (a newer job
  supersedes it) or when `pull_request_states` already records that head.
- Incremental review: on synchronize, only files changed between the last
  reviewed head and the new head are reviewed (compare API). A failed
  comparison (force push) falls back to a full review.
- Line mapping: a finding maps inline when its end line is visible in the
  diff on the finding's side. Multi-line comments require the whole range in
  one hunk; otherwise the comment degrades to the end line. Unmappable
  findings appear in the summary comment instead.
- Suggestion blocks require a `fixPatch`, a fully added range in one hunk,
  full-range mapping coverage, and no code fences in the replacement.
- Dedupe: each inline comment embeds `<!-- hubolt:finding:<fingerprint> -->`;
  reruns skip fingerprints already present in PR review comments. The summary
  comment is located by `<!-- hubolt:summary -->` and updated, not reposted.
- Reviews are stored append-only: one row per reviewed head with fingerprint
  `pr-<number>-<headSha>`.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | server | Enables the webhook route (with Redis) |
| `GITHUB_TOKEN` / `GH_TOKEN` | worker, github CLI | GitHub API access |
| `REDIS_URL` | server, worker | Queue backend |
| `GITHUB_REPOSITORY` | github CLI | Default repo for post/map-lines |

## CLI

```bash
hubolt webhooks verify-fixture <path> [--event <name>] [--signature <sha256=...>] [--secret <value>]
hubolt worker start [--concurrency <n>]
hubolt github post --pr <number> --from <report.json> [--repo owner/name] [--head <sha>]
hubolt github map-lines --pr <number> --from <report.json> [--repo owner/name]
```

`verify-fixture` treats the fixture file as the raw webhook body (signature
verification is byte-exact). Without `--signature` it prints the expected
header value for the given secret.

## Database

Migration `0008_pull_request_state` adds `pull_request_states`
(repoId, prNumber, headSha, unique on repoId+prNumber) tracking the last
reviewed head per PR.

## Not in this phase

- Analyzer signals in hosted reviews (analyzers need a local toolchain; the
  pipeline runs LLM-only on the worker).
- Per-org GitHub tokens (the worker uses one token from its environment;
  org-scoped credentials can reuse the gateway's CredentialManager later).
- Webhook ingest for non-GitHub SCMs.
