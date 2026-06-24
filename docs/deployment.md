# Deployment

Hubolt supports three deployment paths, all present in the repository:

1. GitHub Action - run reviews on pull requests.
2. Self-hosted server - the Fastify middleware on a Linux server (no Docker),
   with Bitbucket Pipelines for CI/CD.
3. Local dependencies via Docker Compose - for development only.

Related: [`deploy/README.md`](../deploy/README.md) (the detailed server guide) |
[Configuration](configuration.md) | [Database](database.md)

## 1. GitHub Action (PR review)

Defined in [`.github/workflows/hubolt.yml`](../.github/workflows/hubolt.yml) using
the composite action in [`.github/actions/review`](../.github/actions/review). It
runs on pull requests and posts review comments.

Provide provider keys as repository secrets:

```yaml
- uses: ./.github/actions/review
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    google-api-key: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}
    cache-enabled: "true"
    post-comment: "true"
```

## 2. Self-hosted server (no Docker)

The full step-by-step guide is [`deploy/README.md`](../deploy/README.md). It
covers provisioning Ubuntu, installing Node/Postgres/Redis via apt, SSH keys
between Bitbucket and the server, secrets, and rollback. Files:

| File | Role |
|------|------|
| [`deploy/hubolt-server.service`](../deploy/hubolt-server.service) | systemd unit running `node dist/server/index.js`. |
| [`deploy/deploy.sh`](../deploy/deploy.sh) | Pull, build, migrate, restart, health-check, auto-rollback. |
| [`deploy/rollback.sh`](../deploy/rollback.sh) | Revert to the previous commit. |
| [`deploy/env.example`](../deploy/env.example) | Server `.env` template. |
| [`bitbucket-pipelines.yml`](../bitbucket-pipelines.yml) | CI/CD pipeline. |

### Build and production commands

```bash
npm ci
npm run build                 # compiles to dist/ (runs prisma generate)
npm run db:migrate            # prisma migrate deploy
node dist/server/index.js     # or: npm run server
```

### Required production environment variables

At minimum: `DATABASE_URL`, and a provider key (`OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`). Recommended:
`NODE_ENV=production`, `HOST`, `PORT`, `REDIS_URL` (for the gateway),
`CREDENTIAL_MASTER_KEY` (for stored credentials), and any GitHub/notification
secrets you use. See [Configuration](configuration.md) and `deploy/env.example`.

### Database migration considerations

- Run `npm run db:migrate` on every deploy (the deploy script does this).
- `npm run db:check-drift` (run in CI) catches a schema change committed without a
  migration.
- Prisma has no down-migrations - back up before destructive migrations
  (`pg_dump`), see [Database](database.md).

## 3. Local dependencies via Docker Compose (dev only)

[`docker-compose.yml`](../docker-compose.yml) runs Postgres + Redis for local
development. It does not run the app itself.

```bash
npm run db:start        # docker-compose up -d
npm run db:migrate
npm run dev:server
```

## CI/CD pipelines

### GitHub Actions CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))

On every PR and pushes to `main`/`master`, on Node 20:

1. `npm ci`
2. `npx prisma generate`
3. `npm run typecheck`
4. `npm test`
5. `npm run db:check-drift` (against a throwaway `postgres:16` service)

### Bitbucket Pipelines ([`bitbucket-pipelines.yml`](../bitbucket-pipelines.yml))

On pull requests and `main`: `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`. On `main` a manual deploy step SSHes to the server and runs
`deploy/deploy.sh` (pull, build, migrate, restart). Secrets used: the Pipelines
SSH key plus `DEPLOY_USER` and `DEPLOY_HOST` variables - no app secrets in
Bitbucket. Remove `trigger: manual` for automatic deploys.

## Post-deployment verification

```bash
curl -fsS http://127.0.0.1:3000/health     # database.connected should be true
curl http://127.0.0.1:3000/ui              # control panel loads
systemctl status hubolt-server             # service active (self-hosted)
```

## Rollback

```bash
cd /opt/hubolt && bash deploy/rollback.sh
```

`deploy.sh` also rolls back automatically if the post-restart health check fails.
Database rollback is manual (see [Database](database.md)).
