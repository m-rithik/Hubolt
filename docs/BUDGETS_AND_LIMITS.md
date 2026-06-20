# Budgets and Rate Limiting

Hubolt server enforces budget limits and rate limits on model API usage to control costs and prevent abuse.

## Budgets

Budgets track monthly spending per provider and enforce spend limits.

### Budget Model

- `orgId`: Organization ID
- `provider`: Model provider (e.g., "anthropic", "openai")
- `monthlyLimitUsd`: Maximum spend allowed per month
- `alertThresholdPct`: Percentage of budget (1-100) at which alerts are triggered (default 80%)
- `currentMonthCostUsd`: Accumulated cost in current month
- `currentMonthResets`: Date when monthly counter resets

### API Endpoints

#### Get all budgets for organization
```bash
GET /budgets
Authorization: Bearer <api-key>
```

Response:
```json
{
  "budgets": [
    {
      "id": "budget-123",
      "provider": "anthropic",
      "monthlyLimitUsd": 1000,
      "alertThresholdPct": 80,
      "currentMonthCostUsd": 650,
      "percentageUsed": 65,
      "createdAt": "2026-06-01T00:00:00Z",
      "updatedAt": "2026-06-05T12:30:00Z"
    }
  ]
}
```

#### Get budget for specific provider
```bash
GET /budgets/{provider}
Authorization: Bearer <api-key>
```

#### Create or update budget
```bash
POST /budgets
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "provider": "anthropic",
  "monthlyLimitUsd": 1000,
  "alertThresholdPct": 80
}
```

Response: `201 Created` with budget details

#### Update budget settings
```bash
PATCH /budgets/{provider}
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "monthlyLimitUsd": 2000,
  "alertThresholdPct": 75
}
```

#### Delete budget limit
```bash
DELETE /budgets/{provider}
Authorization: Bearer <api-key>
```

## Budget Enforcement

When a review is ingested via POST /ingest/review:

1. **Check Budget**: If org has a budget for the provider and estimated cost would exceed limit, request is rejected with `402 Payment Required`
2. **Process Review**: If budget check passes, review is ingested normally
3. **Deduct Cost**: After successful ingestion, `estimatedCostUsd` from modelUsage is deducted from current month budget
4. **Alert**: If budget usage exceeds alertThresholdPct, audit event `budget.alert` is created

### Hosted pull-request reviews

Reviews run by the webhook worker (not only CLI ingestion) are gated the same way:

1. **Check Budget**: before fetching the diff or calling the model, the worker checks the org's budget for the selected provider. If it is already exhausted, the review is skipped with no model call. The worker selects Anthropic as `claude`, while budgets key it as `anthropic`; the worker maps between them.
2. **Deduct Cost**: after a completed review, the model cost (from reported token usage, or a token estimate when the provider reports none) is deducted from the month's budget so the cap accrues across runs.

Both steps are best-effort against the budget subsystem: a budget-system error never blocks a review (fail open on error, closed only on a real overage). Cost accrual uses the gateway cost catalog, so a provider/model not present in the catalog accrues an approximate fallback rate rather than an exact cost.

### Budget Check Rejection

```json
{
  "error": "Budget exceeded for provider anthropic",
  "currentCost": 900,
  "monthlyLimit": 1000,
  "percentageUsed": 90
}
```

## Rate Limiting

Rate limits enforce maximum requests per day per organization, provider, and model combination.

### Rate Limit Model

- `orgId`: Organization ID
- `provider`: Model provider
- `model`: Model name
- `windowStart`: Start of current day (UTC)
- `requestCount`: Number of requests made today
- `maxRequestsPerDay`: Maximum allowed requests (default 1000)

### API Endpoints

#### Get all rate limits for today
```bash
GET /rate-limits
Authorization: Bearer <api-key>
```

Response:
```json
{
  "rateLimits": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "requestCount": 45,
      "maxRequestsPerDay": 1000,
      "windowStart": "2026-06-05T00:00:00Z"
    }
  ]
}
```

#### Get rate limit for specific provider/model
```bash
GET /rate-limits/{provider}/{model}
Authorization: Bearer <api-key>
```

#### Update rate limit for provider/model
```bash
PATCH /rate-limits/{provider}/{model}
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "maxRequestsPerDay": 2000
}
```

## Rate Limit Enforcement

When a review is ingested:

1. **Check Rate Limit**: If organization/provider/model combination has exceeded daily limit, request is rejected with `429 Too Many Requests`
2. **Process Review**: If rate limit check passes, review is ingested normally
3. **Increment Counter**: After successful ingestion, request count is incremented for today's window

### Rate Limit Rejection

```json
{
  "success": false,
  "reviewId": "",
  "message": "Rate limit exceeded for anthropic/claude-opus-4-8"
}
```

## Monthly Reset

Budgets are automatically reset at the beginning of each month (1st day, 00:00 UTC). This happens when:
- A budget is created or updated
- Manual reset via future endpoint (planned)

## Audit Logging

All budget and rate limit actions are logged to audit trail:

- `budget.created_or_updated`: Budget limit set
- `budget.updated`: Budget settings changed
- `budget.deleted`: Budget limit removed
- `budget.alert`: Organization exceeded alert threshold
- `rate_limit.updated`: Rate limit threshold changed
- `review.ingested`: Review ingested with cost and other details

Query audit logs with: GET /audit/export
