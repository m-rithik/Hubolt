# Schema, Migrations, and CI

How the Prisma schema, migration history, and drift gate fit together after the
2026-06 remediation.

## Migration history

Tracked migrations now run `0001` through `0016`:

- `0014_api_key_role` — adds the `role` column to `api_keys`.
- `0015_api_key_member` — adds the optional `memberId` owner link.
- `0016_reconcile_fk_cascade_and_gateway_logs` — see below.

`0014` and `0015` previously existed only locally; they are now committed so a
clean checkout applies the full history.

## `0016` — foreign-key cascade and gateway_logs reconciliation

A database built purely from migrations differed from `schema.prisma` in two
real ways, surfaced by `prisma migrate diff`:

1. **Foreign keys lacked the cascade actions the schema declares.** Nine FKs
   (on `organization_members`, `api_keys`, `repositories`, `reviews`,
   `findings`, `analyzer_signals`, `model_usage`, `budgets`) were created without
   `ON DELETE CASCADE ON UPDATE CASCADE`, so the cascade deletes the schema
   intends (deleting an org cascading to its members/keys/repos/budgets; deleting
   a review cascading to its findings) were not enforced at the database level.
   `0016` drops and re-adds them with the cascade actions. This is
   non-destructive: re-adding a constraint re-validates existing rows, it does
   not delete data.
2. **`gateway_logs` kept its old index/PK names.** The table was renamed from
   `llm_gateway_requests` in an earlier migration without renaming its primary
   key or indexes. `0016` renames them (metadata-only).

Verified: after `0016`, `prisma migrate diff` reports "No difference detected",
and migrations `0001`–`0016` apply cleanly to a fresh database.

## Drift gate

- Script: `npm run db:check-drift` runs
  `prisma migrate diff --from-migrations ./prisma/migrations --to-schema
  ./prisma/schema.prisma --exit-code`. It exits non-zero when the tracked
  migrations no longer reproduce `schema.prisma` — i.e. someone changed the
  schema without writing a migration.
- It needs a throwaway database: set `SHADOW_DATABASE_URL` (and `DATABASE_URL`).
  `prisma.config.ts` reads `shadowDatabaseUrl` from `SHADOW_DATABASE_URL`.
- Locally:

  ```bash
  export DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_db"
  export SHADOW_DATABASE_URL="postgresql://hubolt:hubolt_dev@localhost:5432/hubolt_drift_shadow"
  # the shadow database must exist; create it once, then:
  npm run db:check-drift
  ```

## CI workflow

`.github/workflows/ci.yml` provisions a Postgres service and runs, in order:
`npm ci` -> `prisma generate` -> `typecheck` -> `test` -> `db:check-drift`.

The drift step is **blocking** (the pre-existing drift it would have failed on
is resolved by `0016`). If a future schema change lands without a migration, CI
fails until a migration is added.

## When you change the schema

1. Edit `prisma/schema.prisma`.
2. Generate a migration (`prisma migrate dev --name <change>` against a dev DB).
3. Commit the new migration directory alongside the schema change.
4. `npm run db:check-drift` must report no difference.
