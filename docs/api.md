# API & Integrations

The Hubolt server exposes a REST API (Fastify), a web control panel at `/ui`, and
adapters for third-party services. Endpoints below are taken directly from
[`src/server/routes/`](../src/server/routes/) and registered in
[`src/server/app.ts`](../src/server/app.ts).

Related: [Features](features.md) | [Security](security.md) | [Database](database.md)

## Base URL and authentication

- Base URL: `http://127.0.0.1:3000` by default (`HOST`/`PORT`).
- Auth: send `Authorization: Bearer <api-key>` on protected endpoints. Create a
  key with `hubolt server bootstrap` (see [Getting Started](getting-started.md)).
- Roles: keys are `admin` or `viewer`. State-changing endpoints require an
  `admin` key (`requireAdmin`). Keys created before roles existed are treated as
  admin.

```bash
KEY=<YOUR_HUBOLT_API_KEY>
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/orgs/current
```

### Error responses

| Status | Meaning |
|--------|---------|
| 401 | Missing/invalid `Authorization` header, invalid key, or expired key. |
| 403 | Authenticated but not an admin on an admin-only route. |
| 404 | Resource not found. |
| 500 | Server error (e.g. auth lookup failure). |

Error bodies are JSON, e.g. `{"error":"Invalid API key"}`.

## Endpoints

### Health (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + DB connectivity. |
| GET | `/ready` | Readiness probe. |

```bash
curl -fsS http://127.0.0.1:3000/health
# {"status":"ok","timestamp":"...","uptime":12.3,"database":{"connected":true,"latencyMs":1}}
```

### Control panel (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/`, `/ui`, `/ui/` | Web control panel (static UI from `web/`). |

### Organization, keys, members (Bearer)

| Method | Path | Purpose | Admin |
|--------|------|---------|-------|
| GET | `/auth/me` | Current key's identity/role. | no |
| GET | `/orgs/current` | Current organization. | no |
| PATCH | `/orgs/current` | Update organization. | yes |
| GET | `/orgs/current/api-keys` | List API keys. | yes |
| POST | `/orgs/current/api-keys` | Create an API key. | yes |
| DELETE | `/orgs/current/api-keys/:keyId` | Revoke an API key. | yes |
| GET | `/orgs/current/members` | List members. | yes |
| POST | `/orgs/current/members` | Add a member. | yes |
| PATCH | `/orgs/current/members/:memberId` | Change a member role. | yes |
| DELETE | `/orgs/current/members/:memberId` | Remove a member. | yes |

### Reviews and history (Bearer)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest/review` | Ingest a review report (used by `push-report`). |
| GET | `/history/reviews` | List stored reviews. |
| GET | `/history/reviews/:id` | One review with findings. |
| GET | `/history/trends` | Aggregated review trends. |

### Feedback and memory (Bearer)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/feedback` | Store finding feedback. |
| GET | `/memory/cards` | List memory cards. |
| POST | `/memory/cards` | Create/update a memory card. |
| DELETE | `/memory/cards/:id` | Delete a memory card. |
| POST | `/memory/rebuild` | Rebuild cards from feedback. |

### Budgets and rate limits (Bearer)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/budgets` | List budgets. |
| GET | `/budgets/:provider` | Budget for a provider. |
| POST | `/budgets` | Create a budget. |
| PATCH | `/budgets/:provider` | Update a budget. |
| DELETE | `/budgets/:provider` | Delete a budget. |
| GET | `/rate-limits` | List rate limits. |
| GET | `/rate-limits/:provider/:model` | One rate limit. |
| PATCH | `/rate-limits/:provider/:model` | Update a rate limit. |

### LLM gateway (Bearer; only if Redis is available)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/gateway/complete` | Run an LLM completion through the gateway. |
| GET | `/gateway/status` | Gateway health/status. |
| GET | `/gateway/models` | Model catalog. |
| POST | `/gateway/credentials` | Store an encrypted provider credential. |
| DELETE | `/gateway/credentials/:provider` | Remove a provider credential. |

Gateway routes are registered only when the server connects to Redis. Without
Redis they return 404.

### GitHub repositories (Bearer)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/github-repos` | List connected repos. |
| POST | `/github-repos` | Connect a repo. |
| DELETE | `/github-repos/:owner/:repo` | Disconnect a repo. |
| GET | `/github-repos/status` | Connection status. |
| PUT | `/github-repos/review-model` | Set the review model for repos. |

### Audit and webhooks

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/audit/export` | Bearer | Export audit events. |
| POST | `/webhooks/github` | Signature | Receive GitHub App webhooks. Verified with `GITHUB_APP_WEBHOOK_SECRET`, not a Bearer key. |

Request/response field shapes for POST/PATCH endpoints are defined in each route
file under [`src/server/routes/`](../src/server/routes/). They are intentionally
not duplicated here to avoid drift; read the route or use `/ui`.

## Third-party integrations

Configured through `.hubolt.yml` (`integrations.*`) and environment secrets.
Adapters live in [`src/integrations/`](../src/integrations/).

| Integration | Configure | Secret |
|-------------|-----------|--------|
| GitHub (PR comments) | `hubolt github post` | `GITHUB_TOKEN` / `GH_TOKEN` |
| GitHub App (webhooks) | server + `POST /webhooks/github` | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` |
| Slack | `integrations.slack` | `HUBOLT_SLACK_WEBHOOK_URL` |
| Microsoft Teams | `integrations.teams` | `HUBOLT_TEAMS_WEBHOOK_URL` |
| Jira | `integrations.jira` | per-adapter setup (`hubolt integrations setup`) |
| ClickUp | `integrations.clickup` | per-adapter setup |
| Asana | `integrations.asana` | per-adapter setup |

Test a configured integration:

```bash
npm run dev -- integrations list
npm run dev -- integrations test slack
```

Needs confirmation: exact secret variable names for Jira/ClickUp/Asana are set via
`integrations setup`; confirm against `src/integrations/` for your version.
