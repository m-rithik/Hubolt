import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cancel, confirm, intro, isCancel, outro, select, text } from "@clack/prompts";
import type { Command } from "commander";
import { isMap, parseDocument } from "yaml";
import { DEFAULT_CONFIG_FILE } from "../../config/defaults.js";
import { writeEnvFile } from "../../config/env-file.js";
import { resolveSettings } from "../../config/resolve.js";
import { RepoConfigSchema, type RepoConfig } from "../../config/schema.js";
import { SLACK_WEBHOOK_ENV, TEAMS_WEBHOOK_ENV } from "../../integrations/env-names.js";
import { buildIntegrations, dispatchIntegrations } from "../../integrations/registry.js";
import { createSlackAdapter } from "../../integrations/slack.js";
import { createTeamsAdapter } from "../../integrations/teams.js";
import type { IntegrationAdapter, IntegrationEvent } from "../../integrations/types.js";
import { renderStarterConfig } from "../starter-config.js";
import type { Severity } from "../../types/finding.js";
import { EMPTY_SEVERITY_COUNTS } from "../../types/reports.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface IntegrationsOptions {
  config?: string;
}

const SEVERITY_OPTIONS = [
  { value: "critical", label: "critical only" },
  { value: "high", label: "high and above" },
  { value: "medium", label: "medium and above" },
  { value: "low", label: "low and above" },
  { value: "info", label: "everything" }
] as const;

/** Notification adapters that share the webhook-setup flow. */
const KNOWN_INTEGRATIONS = [
  { name: "slack", label: "Slack (incoming webhook)", placeholder: "https://hooks.slack.com/services/...", secretEnv: SLACK_WEBHOOK_ENV },
  { name: "teams", label: "Microsoft Teams (incoming webhook)", placeholder: "https://...webhook.office.com/...", secretEnv: TEAMS_WEBHOOK_ENV }
] as const;

type IntegrationSettings = { enabled: boolean; minSeverity: Severity };

function integrationSettings(config: RepoConfig, name: string): IntegrationSettings {
  // KNOWN_INTEGRATIONS only holds the notification adapters (slack, teams),
  // which share this shape; issue-tracker config is read elsewhere.
  return (config.integrations as unknown as Record<string, IntegrationSettings>)[name];
}

function adapterFor(
  name: string,
  opts: { webhookUrl: string | undefined; minSeverity: Severity; fetchImpl?: typeof fetch }
): IntegrationAdapter {
  return name === "teams" ? createTeamsAdapter(opts) : createSlackAdapter(opts);
}

export function registerIntegrationsCommand(program: Command): void {
  const integrations = program
    .command("integrations")
    .description("Inspect and test external integration adapters.");

  integrations
    .command("setup")
    .description("Interactive setup: pick an integration, paste its secret, enable it.")
    .option("--config <path>", "config file path")
    .action((options: IntegrationsOptions) => runSafelyAsync(() => setupIntegration(options)));

  integrations
    .command("list")
    .description("List enabled and available integration adapters.")
    .option("--config <path>", "config file path")
    .action((options: IntegrationsOptions) => runSafelyAsync(() => listIntegrations(options)));

  integrations
    .command("test <name>")
    .description("Send a sample event to one configured integration.")
    .option("--config <path>", "config file path")
    .action((name: string, options: IntegrationsOptions) =>
      runSafelyAsync(() => testIntegration(name, options))
    );
}

function loadRepoConfig(options: IntegrationsOptions) {
  return resolveSettings({ cwd: process.cwd(), configPath: options.config }).repo;
}

async function setupIntegration(options: IntegrationsOptions): Promise<void> {
  const config = loadRepoConfig(options);

  intro("Hubolt integration setup");

  const choice = await select({
    message: "Integration",
    options: KNOWN_INTEGRATIONS.map((entry) => ({ value: entry.name, label: entry.label }))
  });
  if (isCancel(choice)) {
    return cancel("Setup cancelled. No changes written.");
  }

  const name = choice as string;
  const meta = KNOWN_INTEGRATIONS.find((entry) => entry.name === name)!;
  const settings = integrationSettings(config, name);

  const webhookUrl = await text({
    message: `Paste the ${meta.label} URL`,
    placeholder: meta.placeholder,
    validate: (value) =>
      (value ?? "").trim().startsWith("https://") ? undefined : "Enter the full https:// webhook URL."
  });
  if (isCancel(webhookUrl)) {
    return cancel("Setup cancelled. No changes written.");
  }

  const minSeverity = await select({
    message: "Notify on findings at",
    options: SEVERITY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    initialValue: settings.minSeverity
  });
  if (isCancel(minSeverity)) {
    return cancel("Setup cancelled. No changes written.");
  }

  const sendTest = await confirm({ message: "Send a test message now?", initialValue: true });
  if (isCancel(sendTest)) {
    return cancel("Setup cancelled. No changes written.");
  }

  const envVar = meta.secretEnv;
  const url = webhookUrl.trim();

  // Secret goes to the gitignored .env; only the non-secret toggle and floor
  // go into the committed .hubolt.yml.
  writeEnvFile(resolve(process.cwd(), ".env"), { [envVar]: url });
  const configPath = resolve(process.cwd(), options.config ?? DEFAULT_CONFIG_FILE);
  enableIntegrationInConfig(configPath, name, minSeverity);

  if (sendTest) {
    const adapter = adapterFor(name, { webhookUrl: url, minSeverity: minSeverity as Severity });
    const result = await adapter.deliver(sampleEvent());
    if (!result.ok) {
      outro(`Saved, but the test failed: ${result.error ?? "unknown error"}. Check the URL and retry with: hubolt integrations test ${name}`);
      return;
    }
  }

  outro(
    `${name} enabled in ${DEFAULT_CONFIG_FILE}; secret saved to .env (${envVar}). ` +
      `Reviews now post a summary. Re-test anytime with: hubolt integrations test ${name}`
  );
}

/** Flip an integration on in the YAML config, preserving comments. */
function enableIntegrationInConfig(configPath: string, name: string, minSeverity: string): void {
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : renderStarterConfig();
  const document = parseDocument(raw);

  if (document.errors.length > 0) {
    throw new Error(`Cannot update ${configPath}: invalid YAML.`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`Cannot update ${configPath}: expected a YAML mapping at the top level.`);
  }

  document.setIn(["integrations", name, "enabled"], true);
  document.setIn(["integrations", name, "minSeverity"], minSeverity);
  RepoConfigSchema.parse(document.toJS());
  writeFileSync(configPath, String(document));
}

async function listIntegrations(options: IntegrationsOptions): Promise<void> {
  const config = loadRepoConfig(options);
  const adapters = buildIntegrations(config);

  const rows = KNOWN_INTEGRATIONS.map((meta) => {
    const settings = integrationSettings(config, meta.name);
    const adapter = adapters.find((entry) => entry.name === meta.name);
    return [
      meta.name,
      settings.enabled ? "yes" : "no",
      adapter?.available() ? "yes" : "no",
      meta.secretEnv
    ];
  });

  console.log(ui.grid(["Integration", "Enabled", "Available", "Secret env"], rows));

  for (const meta of KNOWN_INTEGRATIONS) {
    const settings = integrationSettings(config, meta.name);
    const adapter = adapters.find((entry) => entry.name === meta.name);
    if (settings.enabled && !adapter?.available()) {
      console.log("");
      console.log(ui.muted(`${meta.name} is enabled but ${meta.secretEnv} is not set.`));
    }
  }
}

async function testIntegration(name: string, options: IntegrationsOptions): Promise<void> {
  const config = loadRepoConfig(options);
  const adapter = buildIntegrations(config).find((entry) => entry.name === name);

  if (!adapter) {
    throw new Error(`Integration "${name}" is not enabled. Enable integrations.${name} in your config.`);
  }

  const result = await adapter.deliver(sampleEvent());

  console.log(ui.section(`Integration test: ${name}`, [
    ["Delivered", result.ok ? "yes" : "no"],
    ["Status", result.status !== undefined ? String(result.status) : "-"],
    ["Redacted", result.redacted ? "yes" : "no"],
    ["Error", result.error ?? "-"]
  ]));

  if (result.ok) {
    console.log(ui.success(`Sent a test event to ${name}.`));
  } else {
    process.exitCode = 1;
    console.log(ui.error(`Delivery to ${name} failed.`));
  }
}

/** A representative event so a test exercises formatting and transport. */
function sampleEvent(): IntegrationEvent {
  return {
    kind: "review.completed",
    scope: "integration test",
    status: "ok",
    mode: "balanced",
    provider: "test",
    model: "test",
    summary: { total: 1, bySeverity: { ...EMPTY_SEVERITY_COUNTS, high: 1 } },
    findings: [
      {
        ruleId: "test.sample",
        title: "Sample finding from hubolt integrations test",
        severity: "high",
        category: "quality",
        file: "src/example.ts",
        lineStart: 1,
        lineEnd: 1
      }
    ],
    truncated: false,
    generatedAt: new Date().toISOString()
  };
}
