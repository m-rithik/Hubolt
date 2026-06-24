# Fixes and Remediation

This folder documents the bug-fix and hardening work done against the Hubolt
repository during the 2026-06 audit remediation. It is a maintainer reference,
not end-user documentation (see the rest of `docs/` for operational guides).

## Contents

- [audit-remediation.md](audit-remediation.md) — the full fix log: every
  finding fixed, grouped by round and severity, with root cause, files touched,
  tests, and current status.
- [security-hardening.md](security-hardening.md) — the trust-boundary decisions
  behind the security fixes (what input is trusted, where secrets come from,
  what is rejected). Read this before changing integrations, ingestion, auth,
  or error handling.
- [schema-migrations-and-ci.md](schema-migrations-and-ci.md) — migration
  tracking, the `0016` foreign-key/cascade reconciliation, the migration-drift
  gate, and the CI workflow.

## Status legend

- **Fixed** — code change landed and covered by a test.
- **Verify before release** — fixed as best effort; needs a human/runtime check
  that this environment cannot perform (e.g. a live provider).
- **By design** — intentionally not changed; rationale recorded.
- **Follow-up** — known gap that is infrastructure, not a bug.

## Validation at time of writing

- `npm run typecheck`: clean (now generates the Prisma client first via
  `pretypecheck`).
- `npm test`: 460 passing across 62 files.
- `npm run db:check-drift`: "No difference detected" against a Postgres shadow
  database; migrations `0001`–`0016` apply cleanly to a fresh database.

Passing checks are recorded as context, not proof of correctness.
