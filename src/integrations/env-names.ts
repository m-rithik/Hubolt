/**
 * Hardcoded environment variable names for integration secrets. These are NOT
 * configurable: repository config is untrusted (the hosted worker loads it
 * from the PR head), so letting it choose which env var to read would let a
 * malicious PR remap a webhook/token onto a server secret (e.g. DATABASE_URL)
 * and exfiltrate it via delivery or error logs.
 */
export const SLACK_WEBHOOK_ENV = "HUBOLT_SLACK_WEBHOOK_URL";
export const TEAMS_WEBHOOK_ENV = "HUBOLT_TEAMS_WEBHOOK_URL";
export const JIRA_TOKEN_ENV = "HUBOLT_JIRA_TOKEN";
export const CLICKUP_TOKEN_ENV = "HUBOLT_CLICKUP_TOKEN";
export const ASANA_TOKEN_ENV = "HUBOLT_ASANA_TOKEN";

// Jira sends an HTTP Basic credential (email + API token) to baseUrl, so the
// destination and email are part of the secret boundary and are operator-only,
// never read from repo config: a hostile .hubolt.yml could otherwise point the
// base at an attacker host and exfiltrate the token.
export const JIRA_BASE_URL_ENV = "HUBOLT_JIRA_BASE_URL";
export const JIRA_EMAIL_ENV = "HUBOLT_JIRA_EMAIL";
