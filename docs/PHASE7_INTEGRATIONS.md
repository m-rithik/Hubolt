# Phase 7: External Integrations

Status: In progress - notification adapters (Slack, Teams) and issue trackers
(Jira, ClickUp, Asana)
Date: 2026-06-17

External services receive a typed, redacted summary of a completed review,
and a review report can be turned into tracker issues on demand. This phase
landed two families on shared boundaries: notification adapters and
issue-creation targets. SCM providers (GitLab, Bitbucket) and enterprise
controls remain.

Caveat: the issue-tracker adapters are built to each provider's documented
REST API and unit-tested by asserting the request shape with an injected
fetch, but they have not been exercised against live instances (no
credentials in this environment).

## Architecture

Adapters consume an `IntegrationEvent` and nothing else from the codebase -
they never import core review modules. One mapper bridges the durable
`ReviewReport` to that event, and that is the only place redaction and
finding-capping happen, so no adapter can leak secrets or full source.

| Module | Responsibility |
|---|---|
| `src/integrations/types.ts` | `IntegrationEvent`, `IntegrationAdapter`, `DeliveryResult` contracts |
| `src/integrations/event.ts` | `ReviewReport` -> `IntegrationEvent`: redact text, cap findings |
| `src/integrations/slack.ts` | Slack incoming-webhook adapter; one message per review |
| `src/integrations/teams.ts` | Microsoft Teams adapter; one Adaptive Card per review |
| `src/integrations/registry.ts` | build enabled adapters from config; best-effort dispatch |
| `src/integrations/issues.ts` | issue-creation contract + `buildIssueDrafts` (redacted) |
| `src/integrations/jira.ts` `clickup.ts` `asana.ts` | issue-tracker targets |
| `src/integrations/issue-registry.ts` | build enabled targets; sequential best-effort create |
| `src/cli/commands/integrations.ts` | `hubolt integrations setup / list / test` |
| `src/cli/commands/issues.ts` | `hubolt issues create` (user-triggered) |

## Event boundary

`buildIntegrationEvent(report)` produces the only thing adapters see:

- summary (total + per-severity counts) and threshold-passing findings only
  (the pipeline has already applied the severity threshold);
- findings reduced to `ruleId, title, severity, category, file, lines` - no
  message body or evidence, so there is no per-finding source dump;
- every free-text field (`scope`, finding `title`) run through
  `redactSecrets`, so a secret in a title cannot reach a third party;
- at most 10 findings listed, with `truncated` set when more exist.

## Notification adapters (Slack, Teams)

Slack posts a single mrkdwn message; Teams posts a single Adaptive Card via
the Workflows message envelope. Both take the same options (webhook URL,
`minSeverity` floor, injected `fetch`), report a `DeliveryResult`, and read
their secret from an env var (`HUBOLT_SLACK_WEBHOOK_URL`,
`HUBOLT_TEAMS_WEBHOOK_URL`). `hubolt integrations setup` walks both.

## Slack adapter

- Posts exactly one mrkdwn message per review (a header, the severity
  breakdown, and a capped list of notable findings) - never one message per
  finding.
- `minSeverity` (config, default `high`) is the notification floor: findings
  below it are counted in the summary but not listed.
- The webhook URL is a secret. It is read from an environment variable
  (`HUBOLT_SLACK_WEBHOOK_URL` by default), never stored in committed config.
- `fetch` is injected, so message format and transport are unit-tested
  without a network.

## Issue creation (Jira, ClickUp, Asana)

A different shape from notifications: explicit and user-triggered, one issue
per finding. `buildIssueDrafts(report)` turns a saved report into drafts -
threshold-filtered, capped (default 25), each carrying severity, location,
impact, suggestion, verification, and redacted evidence. Targets implement
`IssueTarget.createIssue(draft)`; connection fields come from config and the
secret token from an env var (`HUBOLT_JIRA_TOKEN`, `HUBOLT_CLICKUP_TOKEN`,
`HUBOLT_ASANA_TOKEN`). Creation runs only from the CLI:

```bash
hubolt issues create --from review.json [--to jira,clickup,asana] \
  [--min-severity high] [--dry-run]
```

`--dry-run` lists what would be created without calling any API. Each create
is best-effort and sequential, so one failure does not abort the batch.

## Configuration

Additive block in `.hubolt.yml`; existing configs validate unchanged
(integrations default to disabled):

```yaml
integrations:
  slack:
    enabled: true
    minSeverity: high          # info | low | medium | high | critical
```

Secret env var names are fixed (`HUBOLT_SLACK_WEBHOOK_URL`,
`HUBOLT_TEAMS_WEBHOOK_URL`, `HUBOLT_JIRA_TOKEN`, `HUBOLT_CLICKUP_TOKEN`,
`HUBOLT_ASANA_TOKEN`) and are deliberately NOT configurable: repo config is
untrusted, so it must not be able to point a secret at an arbitrary server env
var.

## CLI

```bash
hubolt integrations setup            # interactive: pick, paste webhook, enable, test
hubolt integrations list             # adapters, enabled/available, secret env
hubolt integrations test slack       # send a sample event; shows redaction + status
```

`setup` writes the secret (webhook URL) to the gitignored `.env` and flips
`integrations.slack.enabled` in `.hubolt.yml` (preserving comments), so the
secret never lands in committed config.

Both a completed local `hubolt review` and the hosted PR-review worker
dispatch to enabled adapters as a best-effort step: no configured integration
is a no-op, and any delivery failure is logged rather than failing the
run. The hosted worker dispatches after the review is persisted and posted,
and writes an `integration.dispatched` audit event recording the adapters and
their status (never the payload or secret).

## Security / constraints honored

- Adapters depend only on the typed event, not core review modules.
- External services receive summaries and threshold-passing findings only.
- Notifications are one message per review (no per-finding spam).
- Secrets (webhook URL) come from the environment, not committed config.
- Payload text is redacted at the boundary.

## Known gaps (next slices)

- Slack and Teams (notification webhooks) and Jira/ClickUp/Asana (issue
  creation) are implemented. The issue-tracker adapters are not yet verified
  against live instances (see the caveat above).
- GitLab/Bitbucket are `ScmProvider` implementations (a separate boundary from
  integrations) and are not built; nor is external audit export.
- The hosted worker reads the webhook secret from the server environment, so
  it is correct for a single-tenant/self-hosted server. Per-org integration
  secrets (so each org notifies its own Slack) are the multi-tenant/RBAC
  slice; until then a multi-tenant operator should leave the global webhook
  env unset. Enablement itself is already per-repo (it rides repo config).
- Config is repo-level. Hosted per-org/per-repo OAuth and RBAC (the wider
  enterprise controls) are not in this slice.
- `hubolt integrations test` builds a synthetic event; there is no live
  per-event replay yet.
