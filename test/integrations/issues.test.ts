import { describe, expect, test, vi } from "vitest";
import { buildIssueDrafts, type IssueDraft } from "../../src/integrations/issues.js";
import { createJiraTarget } from "../../src/integrations/jira.js";
import { createClickUpTarget } from "../../src/integrations/clickup.js";
import { createAsanaTarget } from "../../src/integrations/asana.js";
import { buildIssueTargets, createIssuesIn } from "../../src/integrations/issue-registry.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { EMPTY_SEVERITY_COUNTS, type ReviewReport } from "../../src/types/reports.js";

function finding(over: Record<string, unknown> = {}) {
  return {
    fingerprint: "fp",
    ruleId: "no-raw-input",
    title: "Unbounded query",
    message: "The query has no limit.",
    category: "quality",
    severity: "high",
    confidenceLabel: "high",
    source: "llm",
    range: { file: "a.ts", startLine: 5, endLine: 9, diffSide: "right" },
    evidence: ["const rows = await db.query(sql)"],
    impact: "Could load the whole table.",
    verification: "Add a LIMIT and re-run.",
    relatedSignals: [],
    tags: [],
    ...over
  };
}

function report(findings: unknown[]): ReviewReport {
  return {
    scope: "pr #1",
    status: "ok",
    mode: "balanced",
    provider: "openai",
    model: "gpt",
    generatedAt: "2026-06-17T00:00:00.000Z",
    summary: { total: findings.length, bySeverity: { ...EMPTY_SEVERITY_COUNTS } },
    findings
  } as unknown as ReviewReport;
}

const draft: IssueDraft = {
  title: "[high] Unbounded query",
  body: "Severity: high\nLocation: a.ts:5-9",
  severity: "high",
  ruleId: "no-raw-input",
  labels: ["hubolt", "high", "quality"]
};

describe("buildIssueDrafts", () => {
  test("includes severity, location, verification, evidence and redacts secrets", () => {
    const built = buildIssueDrafts(
      report([finding({ title: "leak AKIAIOSFODNN7EXAMPLE", evidence: ["token=AKIAIOSFODNN7EXAMPLE"] })]),
      { minSeverity: "low" }
    );

    expect(built.drafts).toHaveLength(1);
    const body = built.drafts[0].body;
    expect(body).toContain("Severity: high");
    expect(body).toContain("Location: a.ts:5-9");
    expect(body).toContain("Verification:");
    expect(body).toContain("Evidence:");
    expect(built.drafts[0].title).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(body).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("skips findings below the floor and caps the batch", () => {
    const below = buildIssueDrafts(report([finding({ severity: "low" })]), { minSeverity: "high" });
    expect(below.drafts).toHaveLength(0);

    const many = Array.from({ length: 5 }, (_, i) => finding({ fingerprint: `fp${i}` }));
    const capped = buildIssueDrafts(report(many), { minSeverity: "low", max: 3 });
    expect(capped.drafts).toHaveLength(3);
    expect(capped.truncated).toBe(true);
  });
});

describe("jira target", () => {
  test("posts to the v2 issue endpoint with basic auth and returns key + url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ key: "PROJ-12" }) } as Response);
    const target = createJiraTarget({
      baseUrl: "https://acme.atlassian.net/",
      projectKey: "PROJ",
      email: "bot@acme.dev",
      apiToken: "tok",
      fetchImpl
    });

    const result = await target.createIssue(draft);

    expect(result).toMatchObject({ target: "jira", ok: true, key: "PROJ-12", url: "https://acme.atlassian.net/browse/PROJ-12" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://acme.atlassian.net/rest/api/2/issue");
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Basic ${Buffer.from("bot@acme.dev:tok").toString("base64")}` });
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.fields.project.key).toBe("PROJ");
    expect(sent.fields.labels).not.toContain("a b"); // labels are space-stripped
  });

  test("fails cleanly without config", async () => {
    const result = await createJiraTarget({}).createIssue(draft);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing Jira config");
  });
});

describe("clickup and asana targets", () => {
  test("clickup posts to the list task endpoint with the token header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "abc", url: "https://app.clickup.com/t/abc" }) } as Response);
    const result = await createClickUpTarget({ listId: "999", apiToken: "pk_1", fetchImpl }).createIssue(draft);

    expect(result).toMatchObject({ target: "clickup", ok: true, key: "abc" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.clickup.com/api/v2/list/999/task");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "pk_1" });
  });

  test("asana posts a data-wrapped task with bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ data: { gid: "7", permalink_url: "https://app.asana.com/0/7" } }) } as Response);
    const result = await createAsanaTarget({ projectGid: "100", apiToken: "1/abc", fetchImpl }).createIssue(draft);

    expect(result).toMatchObject({ target: "asana", ok: true, key: "7" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://app.asana.com/api/1.0/tasks");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer 1/abc" });
    expect(JSON.parse((init as RequestInit).body as string).data.projects).toEqual(["100"]);
  });

  test("missing config fails cleanly", async () => {
    expect((await createClickUpTarget({}).createIssue(draft)).ok).toBe(false);
    expect((await createAsanaTarget({}).createIssue(draft)).ok).toBe(false);
  });
});

describe("issue registry", () => {
  test("builds only enabled targets, with the token from the env", () => {
    const config = RepoConfigSchema.parse({
      integrations: {
        jira: { enabled: true, baseUrl: "https://x.atlassian.net", projectKey: "P", email: "a@b.c" },
        asana: { enabled: true, projectGid: "1" }
      }
    });
    const targets = buildIssueTargets(config, { env: { HUBOLT_JIRA_TOKEN: "t", HUBOLT_ASANA_TOKEN: "t" } });
    expect(targets.map((t) => t.name).sort()).toEqual(["asana", "jira"]);
    expect(targets.every((t) => t.available())).toBe(true);
  });

  test("createIssuesIn never throws and collects a result per draft", async () => {
    const target = {
      name: "jira",
      available: () => true,
      createIssue: vi.fn().mockRejectedValue(new Error("boom"))
    };
    const results = await createIssuesIn(target, [draft, draft]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok && r.error === "boom")).toBe(true);
  });
});
