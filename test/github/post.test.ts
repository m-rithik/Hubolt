import { describe, expect, test, vi } from "vitest";
import {
  buildInlineCommentBody,
  buildSummaryBody,
  extractPostedFingerprints,
  findSummaryComment,
  findingMarker,
  SUMMARY_MARKER
} from "../../src/github/comments.js";
import { buildSuggestionBlock } from "../../src/github/suggestions.js";
import { buildDiffIndex } from "../../src/github/line-mapping.js";
import { postReviewToPullRequest } from "../../src/github/post.js";
import type { Finding } from "../../src/types/finding.js";
import type { ReviewReport } from "../../src/types/reports.js";
import type { PullRequestFile, ScmProvider } from "../../src/providers/scm/scm.interface.js";

const PATCH = [
  "@@ -10,4 +10,5 @@",
  " const a = 1;",
  "-const b = old();",
  "+const b = updated();",
  " const c = 3;",
  "+const inserted1 = 4;",
  "+const inserted2 = 5;"
].join("\n");

const FILES: PullRequestFile[] = [{ filename: "src/a.ts", status: "modified", patch: PATCH }];

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "fp-1",
    ruleId: "rule-1",
    title: "Unvalidated input",
    message: "Input is used without validation.",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    source: "llm",
    range: { file: "src/a.ts", startLine: 11, endLine: 11, diffSide: "right" },
    evidence: ["line 11 uses raw input"],
    impact: "Possible injection.",
    verification: "Trace the input to the sink.",
    relatedSignals: [],
    tags: [],
    ...overrides
  } as Finding;
}

function makeReport(findings: Finding[], commentBudget = 8): ReviewReport {
  const bySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  return {
    findings,
    summary: { total: findings.length, bySeverity },
    config: { mode: "balanced", commentBudget, security: { commentBudget: 12 } }
  } as unknown as ReviewReport;
}

function makeScm(options: {
  issueComments?: Array<{ id: number; body: string }>;
  reviewComments?: Array<{ id: number; body: string; path: string; line: number | null }>;
}): ScmProvider & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getPullRequest: vi.fn(async () => ({
      number: 7,
      headSha: "headsha123",
      baseSha: "base",
      baseRef: "main",
      draft: false
    })),
    listPullRequestFiles: vi.fn(async () => FILES),
    getFileContent: vi.fn(async () => null),
    listIssueComments: vi.fn(async () => options.issueComments ?? []),
    createIssueComment: vi.fn(async (_pr: number, body: string) => ({ id: 100, body })),
    updateIssueComment: vi.fn(async () => undefined),
    listReviewComments: vi.fn(async () => options.reviewComments ?? []),
    createReview: vi.fn(async () => undefined)
  } as unknown as ScmProvider & Record<string, ReturnType<typeof vi.fn>>;
}

describe("comment building blocks", () => {
  test("finding markers round-trip through comment bodies", () => {
    const body = buildInlineCommentBody(makeFinding(), null);
    expect(extractPostedFingerprints([{ body }])).toEqual(new Set(["fp-1"]));
  });

  test("marker sanitizes fingerprints that could break the HTML comment", () => {
    expect(findingMarker("abc--> <script>")).toBe("<!-- hubolt:finding:abc--script -->");
  });

  test("summary comment is found by marker", () => {
    const comments = [
      { id: 1, body: "unrelated" },
      { id: 2, body: `${SUMMARY_MARKER}\nold summary` }
    ];
    expect(findSummaryComment(comments)?.id).toBe(2);
  });

  test("summary body lists findings by severity and unmappable findings", () => {
    const report = makeReport([
      makeFinding({ fingerprint: "fp-low", severity: "low", title: "Minor" }),
      makeFinding({ fingerprint: "fp-crit", severity: "critical", title: "Major" })
    ]);
    const body = buildSummaryBody(report, [{ finding: makeFinding(), reason: "file is not part of this diff" }], "headsha123");

    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body.indexOf("Major")).toBeLessThan(body.indexOf("Minor"));
    expect(body).toContain("Not shown inline");
    expect(body).toContain("headsha123");
  });

  test("suggestion blocks require fixPatch, added-only ranges, and no fences", () => {
    const index = buildDiffIndex(FILES);

    expect(buildSuggestionBlock(makeFinding(), index)).toBeNull();
    expect(
      buildSuggestionBlock(makeFinding({ fixPatch: "const b = safe();" }), index)
    ).toBe("```suggestion\nconst b = safe();\n```");
    expect(
      buildSuggestionBlock(makeFinding({ fixPatch: "x``` injection" }), index)
    ).toBeNull();
    expect(
      buildSuggestionBlock(
        makeFinding({
          fixPatch: "const c = 3;",
          range: { file: "src/a.ts", startLine: 12, endLine: 12, diffSide: "right" }
        }),
        index
      )
    ).toBeNull();
  });
});

describe("postReviewToPullRequest", () => {
  test("posts inline comments, creates summary, and reports counts", async () => {
    const scm = makeScm({});
    const report = makeReport([
      makeFinding({ fixPatch: "const b = safe();" }),
      makeFinding({
        fingerprint: "fp-2",
        title: "Out of diff",
        range: { file: "src/other.ts", startLine: 3, endLine: 3, diffSide: "right" }
      })
    ]);

    const result = await postReviewToPullRequest({ scm, prNumber: 7, report });

    expect(result).toMatchObject({
      headSha: "headsha123",
      inlinePosted: 1,
      summaryOnly: 1,
      skippedDuplicates: 0,
      suggestionsIncluded: 1,
      summaryAction: "created"
    });

    expect(scm.createIssueComment).toHaveBeenCalledTimes(1);
    expect(scm.createReview).toHaveBeenCalledWith(
      7,
      "headsha123",
      undefined,
      [
        expect.objectContaining({
          path: "src/a.ts",
          line: 11,
          side: "RIGHT",
          body: expect.stringContaining("```suggestion")
        })
      ]
    );
  });

  test("reruns update the existing summary and skip posted fingerprints", async () => {
    const postedBody = buildInlineCommentBody(makeFinding(), null);
    const scm = makeScm({
      issueComments: [{ id: 55, body: `${SUMMARY_MARKER}\nprevious` }],
      reviewComments: [{ id: 9, body: postedBody, path: "src/a.ts", line: 11 }]
    });
    const report = makeReport([makeFinding()]);

    const result = await postReviewToPullRequest({ scm, prNumber: 7, report });

    expect(result).toMatchObject({
      inlinePosted: 0,
      skippedDuplicates: 1,
      summaryAction: "updated"
    });
    expect(scm.updateIssueComment).toHaveBeenCalledWith(55, expect.stringContaining(SUMMARY_MARKER));
    expect(scm.createIssueComment).not.toHaveBeenCalled();
    expect(scm.createReview).not.toHaveBeenCalled();
  });

  test("caps inline comments at the configured comment budget", async () => {
    const scm = makeScm({});
    const findings = [
      makeFinding({ fingerprint: "fp-a" }),
      makeFinding({ fingerprint: "fp-b", title: "Second on same line" })
    ];

    const result = await postReviewToPullRequest({
      scm,
      prNumber: 7,
      report: makeReport(findings, 1)
    });

    expect(result).toMatchObject({ inlinePosted: 1, summaryOnly: 1 });
    const summaryBody = (scm.createIssueComment as any).mock.calls[0][1];
    expect(summaryBody).toContain("inline comment budget reached");
  });

  test("summary body caps listed rows for very large reviews", async () => {
    const findings = Array.from({ length: 60 }, (_, i) =>
      makeFinding({ fingerprint: `fp-${i}`, title: `Finding ${i}` })
    );
    const body = buildSummaryBody(makeReport(findings), [], "headsha123");

    expect(body).toContain("And 20 more finding(s)");
    expect(body.length).toBeLessThan(65536);
  });

  test("uses the provided head sha without fetching the PR", async () => {
    const scm = makeScm({});
    const report = makeReport([]);

    const result = await postReviewToPullRequest({
      scm,
      prNumber: 7,
      report,
      headSha: "explicit-sha"
    });

    expect(result.headSha).toBe("explicit-sha");
    expect(scm.getPullRequest).not.toHaveBeenCalled();
  });
});
