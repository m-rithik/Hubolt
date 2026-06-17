import { redactSecrets } from "../core/redact.js";
import type { Severity } from "../types/finding.js";
import type { ReviewReport } from "../types/reports.js";

/**
 * Issue creation is a different shape from notifications: it is explicit and
 * user-triggered (a `hubolt issues create` run against a report), and it makes
 * one issue per finding carrying the finding's evidence, severity, range, and
 * verification. Targets consume an IssueDraft and nothing else from the
 * codebase; the draft text is redacted at this boundary.
 */

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface IssueDraft {
  title: string;
  /** Plain-text body with severity, location, evidence, and verification. */
  body: string;
  severity: Severity;
  ruleId: string;
  labels: string[];
}

export interface IssueResult {
  target: string;
  ok: boolean;
  /** Provider issue key/id when created (e.g. "PROJ-12"). */
  key?: string;
  url?: string;
  error?: string;
}

export interface IssueTarget {
  readonly name: string;
  /** True when the required configuration and secret are present. */
  available(): boolean;
  createIssue(draft: IssueDraft): Promise<IssueResult>;
}

export interface BuildDraftsOptions {
  /** Findings below this severity are skipped. */
  minSeverity?: Severity;
  /** Hard cap so a noisy review cannot open hundreds of issues. */
  max?: number;
}

export interface BuiltDrafts {
  drafts: IssueDraft[];
  /** True when eligible findings exceeded the cap. */
  truncated: boolean;
}

export function buildIssueDrafts(report: ReviewReport, options: BuildDraftsOptions = {}): BuiltDrafts {
  const floor = SEVERITY_RANK[options.minSeverity ?? "medium"];
  const max = options.max ?? 25;

  const eligible = report.findings.filter((finding) => SEVERITY_RANK[finding.severity] >= floor);
  const drafts = eligible.slice(0, max).map((finding) => toDraft(finding, report));

  return { drafts, truncated: eligible.length > drafts.length };
}

function toDraft(finding: ReviewReport["findings"][number], report: ReviewReport): IssueDraft {
  const lines = [
    `Severity: ${finding.severity} (${finding.category})`,
    `Location: ${finding.range.file}:${finding.range.startLine}-${finding.range.endLine}`,
    `Rule: ${finding.ruleId}`,
    "",
    redact(finding.message),
    "",
    `Impact: ${redact(finding.impact)}`,
    finding.suggestion ? `Suggestion: ${redact(finding.suggestion)}` : null,
    `Verification: ${redact(finding.verification)}`,
    finding.evidence.length > 0
      ? `Evidence:\n${finding.evidence.map((item) => `- ${redact(item)}`).join("\n")}`
      : null,
    "",
    `Reported by Hubolt for ${redact(report.scope)}.`
  ].filter((line): line is string => line !== null);

  return {
    title: `[${finding.severity}] ${redact(finding.title)}`,
    body: lines.join("\n"),
    severity: finding.severity,
    ruleId: finding.ruleId,
    labels: ["hubolt", finding.severity, finding.category]
  };
}

function redact(text: string): string {
  return redactSecrets(text).text;
}
