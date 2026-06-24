# Audit Remediation Fix Log

Chronological fix log for the 2026-06 audit remediation, grouped by round and
severity. Each entry lists the root cause, the files changed, the test that
covers it, and status.

---

## Round 1 — first repository audit (9 findings)

### High

**F1 — Viewer API keys could perform writes and spend budget**
- Root cause: mutation and cost endpoints ran only `authMiddleware`, never
  enforcing the read-only `viewer` role the schema defines.
- Fix: added `requireAdmin` to `POST /gateway/complete`, `POST/DELETE
  /memory/cards`, `POST /memory/rebuild`, `PATCH /rate-limits/:p/:m`,
  `POST /feedback`; `/ingest/review` checks the key's `role` directly (it
  authenticates by body key, not the header).
- Files: `src/server/routes/{gateway,memory,rate-limits,feedback,ingest}.ts`.
- Tests: viewer -> 403 / admin -> pass for each surface.
- Behavior change: a `viewer` key can no longer ingest reviews or call the
  gateway. New keys default to `viewer`, so CI/ingest must use an admin key.
- Status: Fixed.

**F2 — Only one GitHub webhook secret honored**
- Root cause: `GITHUB_WEBHOOK_SECRET || GITHUB_APP_WEBHOOK_SECRET` selected a
  single secret, rejecting deliveries signed with the other.
- Fix: collect both into `secrets: string[]`; a delivery is accepted if it
  matches any (`options.secrets.some(...)`).
- Files: `src/server/app.ts`, `src/server/routes/webhooks.ts`.
- Tests: payload signed with the App secret while the standalone secret is set -> 202.
- Status: Fixed.

**F3 — Migrations `0014`/`0015` untracked**
- Root cause: `prisma/migrations/0014_api_key_role` and `0015_api_key_member`
  existed locally but were never committed, so a clean checkout through `0013`
  would fail at runtime with missing-column errors.
- Fix: tracked both migrations; added the `db:check-drift` script, a
  `shadowDatabaseUrl` in `prisma.config.ts`, and a CI workflow. (See
  [schema-migrations-and-ci.md](schema-migrations-and-ci.md).)
- Status: Fixed.

### Medium

**F4 — `hubolt review <file> --show-context` crashed**
- Root cause: `buildSingleFileContext` returned `allFiles` under an `as any`
  cast, but `BuiltContext` and its consumers use `files`, so `context.files`
  was `undefined`.
- Fix: return `{ scope, files, reviewable }`; removed the cast and orphaned locals.
- Files: `src/core/single-file-reviewer.ts`.
- Tests: `test/core/single-file-reviewer.test.ts`.
- Status: Fixed.

**F5 — Failed ingest refunded budget but not the rate-limit slot**
- Root cause: `reserveUsage` increments both the monthly budget and the daily
  rate-limit window; the failure path called only `refundUsage`.
- Fix: store `model` in the reservation and call both `refundUsage` and
  `refundRateLimit` on failure.
- Files: `src/server/routes/ingest.ts`.
- Tests: write fails after reservation -> exactly two refund UPDATEs.
- Status: Fixed.

**F8 — Last-admin guard was race-prone**
- Root cause: admin count and the demote/delete ran outside any transaction or
  lock, so two concurrent demotions could each see two admins and leave zero.
- Fix: run the guard and the mutation in one `$transaction`; count admins under
  `SELECT ... FOR UPDATE`. Control flow uses `ApiKeyMutationError` -> HTTP status.
- Files: `src/server/routes/orgs.ts`.
- Tests: `test/server/orgs-key-roles.test.ts` (lock path + existing guards).
- Note: true serialization needs a real database; the unit test asserts the
  transaction/lock path runs.
- Status: Fixed.

**F9 — Hosted worker fell back to operator env keys on credential failure**
- Root cause: credential-resolution errors were swallowed, silently falling
  back to the operator's environment key (wrong account billed in multi-tenant).
- Fix: fail closed — `getCredential` returning `null` (no credential
  configured) still falls back to env (single-tenant), but a decrypt/resolution
  error now propagates and fails the job, consistent with the SCM-credential path.
- Files: `src/queue/worker.ts`.
- Tests: `test/queue/worker-credentials.test.ts`.
- Status: Fixed.

### Low

**F6 — `.env` writer corrupted values containing single quotes**
- Root cause: shell-style `'\''` escaping is not understood by `dotenv` (the
  actual reader), so a value like `abc'def` reloaded differently.
- Fix: single-quote only when there is no `'`; otherwise double-quote; reject a
  value mixing a single quote with a double quote, backslash, or newline rather
  than corrupt it.
- Files: `src/config/env-file.ts`.
- Tests: round-trip and rejection cases in `test/config/env-file.test.ts`.
- Status: Fixed.

**F7 — CLI and report version hard-coded and stale**
- Root cause: `0.1.0` hard-coded in two places while `package.json` was `0.2.3`.
- Fix: single `src/version.ts` reads `package.json`; CLI and report builder
  import it.
- Files: `src/version.ts`, `src/cli/index.ts`, `src/report/build.ts`.
- Status: Fixed (file tracking corrected in Round 2 / H3).

---

## Round 2 — second repository audit + carried-over low findings

### High

**H1 — Repo-controlled Jira base URL could receive the Jira API token**
- Root cause: `buildIssueTargets` read Jira `baseUrl`/`email` from the
  repo-controlled `.hubolt.yml` and attached the env token, so a hostile repo
  could redirect the Basic-auth credential to its own host.
- Fix: `baseUrl`/`email` now come from `HUBOLT_JIRA_BASE_URL` /
  `HUBOLT_JIRA_EMAIL` (operator env), removed from the repo-config schema;
  `createJiraTarget` enforces HTTPS and rejects embedded userinfo.
- Files: `src/integrations/{env-names,jira,issue-registry}.ts`,
  `src/config/schema.ts`, `docs/PHASE7_INTEGRATIONS.md`.
- Tests: `test/integrations/issues.test.ts`.
- Status: Fixed. (See [security-hardening.md](security-hardening.md).)

**H2 — Ingested repository URLs accepted unsafe schemes and rendered as links**
- Root cause: `z.string().url()` accepts `javascript:`/`data:`/`ftp:`; the value
  was stored and set as an `<a href>` in the control panel.
- Fix: ingest uses an `http(s)`-only schema; the web `el()` helper routes every
  `href` through a new `safeHref()` that collapses unsafe values to `#`.
- Files: `src/server/routes/ingest.ts`, `web/js/dom.js`.
- Tests: `test/server/routes-regression.test.ts` (ingest rejects unsafe schemes).
- Status: Fixed. The `safeHref` client guard has no unit test (no jsdom in the
  test environment); the server-side rejection is the primary, tested guard.

**H3 — Clean checkout could not build (`src/version.ts` untracked)**
- Root cause: tracked source imported `../version.js`, but the file was never
  committed.
- Fix: tracked `src/version.ts`.
- Status: Fixed.

### Medium

**M4 — GitHub Action could adopt a user-authored marker comment**
- Root cause: `findExistingComment` trusted any comment containing the marker,
  which any PR participant can post.
- Fix: require a trusted author — `user.type === "Bot"` (the Actions token) or
  `author_association` in OWNER/MEMBER/COLLABORATOR. Fork participants
  (CONTRIBUTOR/NONE) can no longer hijack the managed comment.
- Files: `.github/actions/review/utils.cjs`.
- Tests: `test/github-action-utils.test.ts`.
- Status: Fixed.

**M5 — Gateway advertised retired Gemini model IDs**
- Root cause: catalog listed `gemini-2.0-flash` and `gemini-1.5-pro`, which
  Google has retired; routing to them fails at the provider.
- Fix: replaced with `gemini-2.5-flash` / `gemini-2.5-pro` across the catalog,
  docs, and landing page.
- Files: `src/server/services/model-catalog.ts`,
  `docs/PHASE5_STEP1_GATEWAY.md`, `docs/CLI_COMMANDS.md`,
  `web/landing/index.html`; test `test/server/model-catalog.test.ts`.
- Status: **Verify before release** — the successor IDs are valid per the
  author's knowledge but were not confirmed against Google's live models
  endpoint from this environment.

**M7 — Prisma client required by typecheck but not generated by it**
- Root cause: `src/generated/` is ignored and `typecheck` was plain
  `tsc --noEmit`, so a clean checkout failed before `prisma generate` ran.
- Fix: added `"pretypecheck": "npx prisma generate"`.
- Files: `package.json`.
- Status: Fixed.

**M8 — Drift gate lived only in an untracked workflow**
- Fix: tracked `.github/workflows/ci.yml`.
- Status: Fixed (gate made blocking in Round 3; see schema doc).

### Low

**L6 — `/ready` leaked raw dependency errors**
- Fix: log server-side, return `{ ready: false }`.
- Files: `src/server/routes/health.ts`. Tests: `test/server/health-routes.test.ts`.
- Status: Fixed.

**L9 — Global error handler exposed 5xx messages**
- Fix: 5xx returns a generic name/message (detail stays in logs); 4xx client
  messages preserved.
- Files: `src/server/middleware/error-handler.ts`. Tests:
  `test/server/error-handler.test.ts`.
- Status: Fixed.

**Carried-over: dead code in the request queue**
- Fix: removed unused `maxCacheSize`, `hashPrompt`, the no-op `cleanOldCache()`
  and its per-job invocation, and the now-unused `createHash` import.
- Files: `src/server/services/request-queue.ts`.
- Status: Fixed.

**Carried-over: git ref option-injection guard**
- Root cause: `base`/`head` (CLI flags) could be parsed as git options.
- Fix: `assertSafeRef` rejects refs beginning with `-` in all four exec paths.
- Files: `src/core/git.ts`. Tests: `test/core/git.test.ts`.
- Status: Fixed.

---

## Round 3 — remaining items

**Budget enforcement on hosted pull-request reviews** (was a product decision)
- Root cause: the webhook->worker review path never consulted budgets, and the
  worker names Anthropic `claude` while budgets key it `anthropic`.
- Fix: `toGatewayProvider()` maps `claude` -> `anthropic`; the worker skips a
  review when the org's budget for that provider is exhausted (pre-check, no
  model call) and deducts the cost after a completed review. Best-effort: fail
  open on a budget-system error, closed only on a real overage. Opt-in — orgs
  with no budget row are unaffected.
- Files: `src/queue/review-processor.ts`, `docs/BUDGETS_AND_LIMITS.md`.
- Tests: `test/queue/review-processor.test.ts` (exhausted -> skipped; completed -> deducted).
- Limitation: cost accrual uses the gateway cost catalog, so a model not in the
  catalog accrues an approximate fallback rate rather than an exact cost.
- Status: Fixed.

**Migration drift reconciliation + blocking CI gate**
- Added `0016_reconcile_fk_cascade_and_gateway_logs` and made the CI drift check
  blocking. (See [schema-migrations-and-ci.md](schema-migrations-and-ci.md).)
- Status: Fixed.

---

## Not changed (with rationale)

- **Gemini model IDs** — needs confirmation against the live Google models
  endpoint (no external access here). Status: Verify before release.
- **Real-database integration test harness** — DB-level correctness (cascade,
  drift, fresh apply) was validated manually against Postgres this round; a
  permanent gated integration suite is infrastructure, not a bug. Status: Follow-up.
- **Truncated-PEM over-redaction** in `src/core/redact.ts` — an unterminated
  `BEGIN PRIVATE KEY` over-redacts the rest of the file. This fails safe
  (over-redacts, never leaks); a "fix" would add leak risk for no security gain.
  Status: By design.
