import { describe, expect, test, vi } from "vitest";
import { buildIntegrationEvent } from "../../src/integrations/event.js";
import { buildSlackText, createSlackAdapter } from "../../src/integrations/slack.js";
import { buildTeamsCard, createTeamsAdapter } from "../../src/integrations/teams.js";
import { buildIntegrations, dispatchIntegrations } from "../../src/integrations/registry.js";
import type { IntegrationAdapter, IntegrationEvent } from "../../src/integrations/types.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { EMPTY_SEVERITY_COUNTS, type ReviewReport } from "../../src/types/reports.js";

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    scope: "pr #1",
    status: "ok",
    mode: "balanced",
    provider: "openai",
    model: "gpt",
    generatedAt: "2026-06-16T00:00:00.000Z",
    summary: { total: 0, bySeverity: { ...EMPTY_SEVERITY_COUNTS } },
    findings: [],
    ...overrides
  } as unknown as ReviewReport;
}

function finding(over: Record<string, unknown> = {}) {
  return {
    ruleId: "r",
    title: "t",
    severity: "high",
    category: "quality",
    range: { file: "a.ts", startLine: 3, endLine: 3, diffSide: "right" },
    ...over
  };
}

function event(overrides: Partial<IntegrationEvent> = {}): IntegrationEvent {
  return {
    kind: "review.completed",
    scope: "pr #1",
    status: "ok",
    mode: "balanced",
    provider: "openai",
    model: "gpt",
    summary: { total: 2, bySeverity: { ...EMPTY_SEVERITY_COUNTS, high: 1, low: 1 } },
    findings: [
      { ruleId: "r1", title: "High issue", severity: "high", category: "security", file: "a.ts", lineStart: 5, lineEnd: 5 },
      { ruleId: "r2", title: "Low nit", severity: "low", category: "quality", file: "b.ts", lineStart: 9, lineEnd: 9 }
    ],
    truncated: false,
    generatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides
  };
}

describe("buildIntegrationEvent", () => {
  test("redacts secrets in titles and scope", () => {
    const built = buildIntegrationEvent(
      report({
        scope: "key AKIAIOSFODNN7EXAMPLE",
        findings: [finding({ title: "leak AKIAIOSFODNN7EXAMPLE here" }) as never]
      })
    );

    expect(built.scope).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(built.findings[0].title).toContain("[REDACTED]");
    expect(built.findings[0].title).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("caps listed findings and flags truncation", () => {
    const many = Array.from({ length: 12 }, (_, i) => finding({ ruleId: `r${i}` }) as never);
    const built = buildIntegrationEvent(report({ findings: many }));

    expect(built.findings).toHaveLength(10);
    expect(built.truncated).toBe(true);
  });
});

describe("buildSlackText", () => {
  test("is one message, lists only findings at or above minSeverity, no emoji", () => {
    const text = buildSlackText(event(), "high");

    expect(text).toContain("*Hubolt review* - pr #1");
    expect(text).toContain("1 high");
    expect(text).toContain("High issue (a.ts:5)");
    expect(text).not.toContain("Low nit"); // below the high floor
    // no emoji: only ASCII / common punctuation
    expect(text).toMatch(/^[\x00-\x7F\n]*$/);
  });

  test("notes truncation when more findings exist", () => {
    const text = buildSlackText(event({ truncated: true }), "low");
    expect(text).toContain("and more");
  });
});

describe("slack adapter deliver", () => {
  test("posts the message to the webhook and reports status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const adapter = createSlackAdapter({ webhookUrl: "https://hooks.slack/x", minSeverity: "high", fetchImpl });

    const result = await adapter.deliver(event());

    expect(result).toMatchObject({ adapter: "slack", ok: true, status: 200, redacted: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hooks.slack/x");
    expect(JSON.parse((init as RequestInit).body as string)).toHaveProperty("text");
  });

  test("fails cleanly when the webhook URL is missing", async () => {
    const adapter = createSlackAdapter({ webhookUrl: undefined, minSeverity: "high" });
    const result = await adapter.deliver(event());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing webhook URL");
  });
});

describe("buildTeamsCard", () => {
  const texts = (card: unknown): string[] => {
    const body = (card as any).attachments[0].content.body as Array<{ text: string }>;
    return body.map((block) => block.text);
  };

  test("builds an Adaptive Card message with summary and severity-floored findings", () => {
    const card = buildTeamsCard(event(), "high") as any;
    expect(card.type).toBe("message");
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.attachments[0].content.type).toBe("AdaptiveCard");

    const joined = texts(card).join("\n");
    expect(joined).toContain("Hubolt review - pr #1");
    expect(joined).toContain("1 high");
    expect(joined).toContain("High issue (a.ts:5)");
    expect(joined).not.toContain("Low nit");
    expect(joined).toMatch(/^[\x00-\x7F\n]*$/); // no emoji
  });
});

describe("teams adapter deliver", () => {
  test("posts the card to the webhook and reports status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const adapter = createTeamsAdapter({ webhookUrl: "https://office.com/hook", minSeverity: "high", fetchImpl });

    const result = await adapter.deliver(event());

    expect(result).toMatchObject({ adapter: "teams", ok: true, status: 200, redacted: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://office.com/hook");
    expect(JSON.parse((init as RequestInit).body as string).type).toBe("message");
  });

  test("fails cleanly when the webhook URL is missing", async () => {
    const result = await createTeamsAdapter({ webhookUrl: undefined, minSeverity: "high" }).deliver(event());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing webhook URL");
  });
});

describe("registry", () => {
  const config = (enabled: boolean) =>
    RepoConfigSchema.parse({ integrations: { slack: { enabled } } });

  test("omits disabled integrations", () => {
    expect(buildIntegrations(config(false))).toHaveLength(0);
  });

  test("builds slack when enabled, availability follows the secret env", () => {
    const withSecret = buildIntegrations(config(true), { env: { HUBOLT_SLACK_WEBHOOK_URL: "https://x" } });
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0].available()).toBe(true);

    const withoutSecret = buildIntegrations(config(true), { env: {} });
    expect(withoutSecret[0].available()).toBe(false);
  });

  test("builds slack and teams together, each from its own secret env", () => {
    const cfg = RepoConfigSchema.parse({ integrations: { slack: { enabled: true }, teams: { enabled: true } } });
    const adapters = buildIntegrations(cfg, {
      env: { HUBOLT_SLACK_WEBHOOK_URL: "https://s", HUBOLT_TEAMS_WEBHOOK_URL: "https://t" }
    });
    expect(adapters.map((a) => a.name).sort()).toEqual(["slack", "teams"]);
    expect(adapters.every((a) => a.available())).toBe(true);
  });

  test("dispatch never throws even if an adapter throws", async () => {
    const thrower: IntegrationAdapter = {
      name: "boom",
      available: () => true,
      deliver: () => Promise.reject(new Error("network down"))
    };

    const results = await dispatchIntegrations(event(), [thrower]);
    expect(results[0]).toMatchObject({ adapter: "boom", ok: false });
    expect(results[0].error).toContain("network down");
  });
});
