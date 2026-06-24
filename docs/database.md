# Database

Hubolt's server uses PostgreSQL through Prisma. Local CLI review does not use the
database.

Related: [Getting Started](getting-started.md) | [Configuration](configuration.md) |
[Deployment](deployment.md)

## Technology

- PostgreSQL 16 (dev compose image `postgres:16-alpine`).
- Prisma 7 with the `@prisma/adapter-pg` driver adapter over a `pg` connection
  `Pool` (see [`src/server/db.ts`](../src/server/db.ts)).
- Connection comes from `DATABASE_URL`. Prisma config loads `.env.local` then
  `.env` (see [`prisma.config.ts`](../prisma.config.ts)).
- Schema: [`prisma/schema.prisma`](../prisma/schema.prisma). Migrations:
  [`prisma/migrations/`](../prisma/migrations/) (`0001` through `0016`).

## Local setup

Use Docker Compose (`npm run db:start`) or a native install - both are covered in
[Getting Started](getting-started.md). Then apply migrations:

```bash
npm run db:migrate        # prisma migrate deploy
```

## Seed data

There is no Prisma seed script. The initial data (organization, admin user, first
API key) is created by:

```bash
npm run dev -- server bootstrap --org local --email you@example.com --no-save-env
```

## Migration commands

| Command | What it does |
|---------|--------------|
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`). |
| `npm run db:reset` | Drop, recreate, and re-apply all migrations. Destroys data. |
| `npm run db:check-drift` | Fail if `schema.prisma` is not reproduced by the tracked migrations. |
| `npm run db:studio` | Open Prisma Studio to browse data. |

Creating a new migration after editing `schema.prisma` (development):

```bash
npx prisma migrate dev --name <change_name>
```

## Rollback

Prisma has no automatic down-migrations. To undo a schema change you either:

- Restore from a backup (below), or
- Write a new forward migration that reverses the change.

Additive migrations (new tables/columns) are usually backward compatible with
older application code; destructive changes (dropped/renamed columns) are not.
See the rollback caveat in [`deploy/rollback.sh`](../deploy/rollback.sh).

## Backup and reset

```bash
# Backup
pg_dump "$DATABASE_URL" > hubolt_backup_$(date +%F_%H%M).sql

# Restore
psql "$DATABASE_URL" < hubolt_backup_YYYY-MM-DD_HHMM.sql

# Full local reset (destroys data)
npm run db:reset
```

## Data model overview

Models defined in `schema.prisma`, grouped by area:

| Area | Models |
|------|--------|
| Identity / access | `Organization`, `OrganizationMember`, `User`, `ApiKey` |
| Repositories / PRs | `Repository`, `PullRequestState` |
| Reviews | `Review`, `Finding`, `AnalyzerSignal`, `FindingFeedback` |
| Cost / governance | `ModelUsage`, `Budget`, `RateLimitWindow`, `AuditEvent` |
| Gateway | `ProviderCredential`, `ModelRoute`, `GatewayLog`, `GatewayBudgetReservation` |
| Memory | `MemoryCard` |

Field-level definitions live in [`prisma/schema.prisma`](../prisma/schema.prisma);
browse live data with `npm run db:studio`.
