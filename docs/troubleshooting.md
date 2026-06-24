# Troubleshooting

Symptoms, likely causes, and concrete fixes. Grouped by stage.

Related: [Getting Started](getting-started.md) | [Configuration](configuration.md) |
[Database](database.md) | [FAQ](faq.md)

## Installation

| Symptom | Cause | Fix |
|---------|-------|-----|
| `engine "node" is incompatible` | Node < 20.19 | Install Node >= 20.19 (`node --version`). |
| `Cannot find module '../generated/prisma'` | Prisma client not generated | `npx prisma generate` (or `npm run build`). |
| `npm install` fails on Prisma | Network/registry issue | Retry; ensure `prisma` and `@prisma/client` install. |

## Configuration

| Symptom | Cause | Fix |
|---------|-------|-----|
| Review runs with no LLM findings | No provider key set | Set `OPENAI_API_KEY` (or Anthropic/Google) in `.env`; `hubolt providers list`. |
| `config validate` reports errors | Invalid `.hubolt.yml` | Fix the reported keys; compare with [`.hubolt.example.yml`](../.hubolt.example.yml). |
| Wrong provider/model used | Defaults from env | Override with `--provider` / `--model`, or set `HUBOLT_LLM_PROVIDER`/`HUBOLT_LLM_MODEL`. |

## Runtime (server)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `DATABASE_URL is required to start the Hubolt server.` | Missing DB URL | Set `DATABASE_URL` in `.env.local` or `.env`. |
| `Connected to database` then `Redis connection failed` | Redis down/unreachable | Start Redis, or ignore - server runs with the gateway disabled. |
| Gateway endpoints return 404 | Redis not connected at startup | Start Redis and restart the server (`/gateway/*` registers only with Redis). |
| 401 on API calls | Missing/invalid Bearer key | Send `Authorization: Bearer <key>`; create one with `server bootstrap`. |
| 403 on POST/PATCH/DELETE | Key is `viewer`, route needs admin | Use an admin key. |
| Port already in use | Another process on `PORT` | `lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill`, or set a different `PORT`. |
| CORS blocked in browser | `CORS_ORIGIN` unset in production | Set `CORS_ORIGIN` to your UI origin. |

## Build

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tsc` type errors | Type regressions | `npm run typecheck` and fix; ensure `prisma generate` ran. |
| `dist/` missing at runtime | Not built | `npm run build` before `npm run server`. |

## Database

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED 127.0.0.1:5432` | Postgres not running | `npm run db:start` (Docker) or `brew services start postgresql@16`. |
| `password authentication failed` | Wrong creds in `DATABASE_URL` | Match the role/password you created; see [Database](database.md). |
| `db:check-drift` fails | Schema changed without a migration | `npx prisma migrate dev --name <change>` and commit it. |
| Migrations error mid-deploy | Partial/destructive migration | Restore from `pg_dump` backup, then re-run. |

## Deployment

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pipeline can't SSH to server | SSH key/known_hosts not set | Configure Pipelines SSH key + known host; see [`deploy/README.md`](../deploy/README.md). |
| `deploy.sh` health check fails | App didn't start | It auto-runs `rollback.sh`; check `journalctl -u hubolt-server`. |
| `sudo: a password is required` in deploy | Missing sudoers rule | Add the NOPASSWD systemctl rule from `deploy/README.md`. |
| Service won't start | Bad `.env` or missing build | Check `/opt/hubolt/.env`, run `npm ci && npm run build` on the server. |

## Still stuck?

- Raise log level: `LOG_LEVEL=debug npm run dev:server`.
- Inspect events: `npm run dev -- logs tail`.
- Verify config: `npm run dev -- config validate`.
- Open an issue: https://github.com/m-rithik/hubolt/issues
