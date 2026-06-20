# Security Hardening Notes

Trust-boundary decisions behind the security fixes. Read this before changing
integrations, ingestion, authentication, webhooks, or error handling — several
of these are non-obvious and easy to regress.

## Trust model in one line

Repository configuration (`.hubolt.yml`) is **untrusted**: the hosted worker
loads it from the pull-request head, so a malicious PR controls it. Operator
environment variables and the server's own configuration are trusted.

## Integration secrets and destinations

- Integration **secrets** are read only from fixed environment variables
  (`src/integrations/env-names.ts`); repo config can never name which env var to
  read. This prevents a malicious PR from remapping a token onto a server secret
  such as `DATABASE_URL`.
- The Jira **destination** is also part of the secret boundary, because the base
  URL is where the `email` + token Basic-auth credential is sent. So
  `HUBOLT_JIRA_BASE_URL` and `HUBOLT_JIRA_EMAIL` are operator-env only and are
  **not** in the repo-config schema. `createJiraTarget` additionally requires
  HTTPS and rejects embedded userinfo.
- Slack/Teams webhook URLs come from the environment; repo config only toggles
  `enabled` and `minSeverity`. ClickUp and Asana use hardcoded API hosts
  (`api.clickup.com`, `app.asana.com`) and take only non-secret IDs from config.

Rule of thumb: anything that decides **where** a credential travels is operator
config, not repo config.

## API-key roles

- `viewer` keys are read-only. State-changing and cost-incurring endpoints call
  `requireAdmin` (gateway completion, memory writes/rebuild, rate-limit updates,
  feedback, org/key/repo management). `/ingest/review` authenticates by body key
  and checks the key's `role` directly.
- Keys created before roles existed have no `role` and are treated as `admin` so
  existing access is preserved. New keys default to `viewer`.
- The last admin key cannot be demoted or deleted; the guard runs in a
  transaction with the admin rows locked `FOR UPDATE` to defeat the concurrent
  case.

## Webhooks

- Signatures are verified over the exact delivered bytes against **any**
  configured secret (`GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_WEBHOOK_SECRET`),
  so neither a manually configured repo webhook nor the App is rejected when
  both secrets are set.

## Stored/rendered URLs

- Repository URLs are restricted to `http(s)` at the ingestion boundary
  (`src/server/routes/ingest.ts`). Defense in depth: the web `el()` helper routes
  every `href` through `safeHref()` (`web/js/dom.js`), which collapses
  `javascript:`/`data:`/unknown schemes to `#`.

## Credentials in the hosted worker

- The worker fails **closed**: if an org has a credential configured for the
  provider but it cannot be decrypted, the job fails rather than silently using
  the operator's environment key. A genuinely missing credential (single-tenant)
  still falls back to the environment.

## Error and readiness output

- The public `/ready` route returns `{ ready: false }` and logs the detail
  server-side; it never echoes raw dependency errors (hostnames, ports, SQL).
- The global error handler returns a generic body for 5xx (detail stays in
  logs) and preserves deliberate 4xx client messages.

## GitHub Action managed comment

- The composite action only adopts an existing review comment whose author is
  trusted — the Actions bot, or a repo OWNER/MEMBER/COLLABORATOR. The hidden
  marker alone is not sufficient, because any PR participant can post it.

## Local git invocation

- `base`/`head` refs (CLI flags) are rejected if they begin with `-`, so they
  cannot be parsed as git options. File paths passed to git come from git's own
  diff output, and all git calls use `execFileSync` with an argument array (no
  shell).
