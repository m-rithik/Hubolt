import type { Finding, Severity } from "../types/finding.js";
import type { ReviewReport } from "../types/reports.js";
import type { IssueComment } from "../providers/scm/scm.interface.js";

export const SUMMARY_MARKER = "<!-- hubolt:summary -->";

const FINDING_MARKER_PREFIX = "<!-- hubolt:finding:";
const FINDING_MARKER_PATTERN = /<!-- hubolt:finding:([A-Za-z0-9._:-]+) -->/g;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

// GitHub rejects comment bodies over 65536 characters; cap rows well before
// that and hard-truncate as a final guard so posting can never 422 on size.
const MAX_SUMMARY_ROWS = 40;
const MAX_SUMMARY_CHARS = 60000;

/** Marker embedded in each inline comment so reruns can skip reposting. */
export function findingMarker(fingerprint: string): string {
  return `${FINDING_MARKER_PREFIX}${sanitizeFingerprint(fingerprint)} -->`;
}

/**
 * Fingerprints are derived hashes, but they pass through model-influenced
 * content; strip anything that could break out of an HTML comment.
 */
function sanitizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
}

/** The fingerprint embedded in one comment body, or null. */
export function extractFingerprint(body: string): string | null {
  const match = new RegExp(FINDING_MARKER_PATTERN.source).exec(body);
  return match ? match[1] : null;
}

/** Collect already-posted finding fingerprints from prior comment bodies. */
export function extractPostedFingerprints(comments: Array<{ body: string }>): Set<string> {
  const fingerprints = new Set<string>();
  for (const comment of comments) {
    for (const match of comment.body.matchAll(FINDING_MARKER_PATTERN)) {
      fingerprints.add(match[1]);
    }
  }
  return fingerprints;
}

/** Locate the bot's stable summary comment among issue comments. */
export function findSummaryComment(comments: IssueComment[]): IssueComment | undefined {
  return comments.find((comment) => comment.body.includes(SUMMARY_MARKER));
}

/** Body of one inline review comment. */
export function buildInlineCommentBody(finding: Finding, suggestionBlock: string | null): string {
  const lines: string[] = [];

  lines.push(`**${finding.title}**  \`${finding.severity}\` · ${finding.category}`);
  lines.push("");
  lines.push(finding.message);

  if (finding.impact) {
    lines.push("");
    lines.push(`**Impact:** ${finding.impact}`);
  }

  if (finding.verification) {
    lines.push("");
    lines.push(`**Verify:** ${finding.verification}`);
  }

  if (suggestionBlock) {
    lines.push("");
    lines.push(suggestionBlock);
  } else if (finding.suggestion) {
    lines.push("");
    lines.push(`**Suggestion:** ${finding.suggestion}`);
  }

  lines.push("");
  lines.push(findingMarker(finding.fingerprint));

  return lines.join("\n");
}

export interface SummaryOnlyFinding {
  finding: Finding;
  reason: string;
}

/**
 * Body of the single stable PR summary comment. Reruns update this comment
 * in place (located via SUMMARY_MARKER) instead of posting a new one.
 */
export function buildSummaryBody(
  report: ReviewReport,
  summaryOnly: SummaryOnlyFinding[],
  headSha: string
): string {
  const lines: string[] = [];
  lines.push(SUMMARY_MARKER);
  lines.push("## Hubolt review");
  lines.push("");

  const total = report.findings.length;
  const worst = worstSeverity([...report.findings, ...summaryOnly.map((entry) => entry.finding)]);

  let headline: string;
  if (total === 0) {
    headline =
      summaryOnly.length === 0
        ? "No findings at or above the configured threshold."
        : `${summaryOnly.length} finding(s) moved to the summary; none posted inline.`;
  } else {
    const counts = SEVERITY_ORDER.map(
      (severity) => `**${severity}** ${report.summary.bySeverity[severity]}`
    ).join(" · ");
    headline = `**${total} finding(s)** · ${counts}`;
  }

  // GitHub alerts are the only native way to color a comment: CAUTION renders
  // red, WARNING amber, NOTE blue, TIP green. Pick by the worst severity so the
  // headline's color tracks how bad the review is.
  lines.push(`> [!${alertType(worst)}]`);
  lines.push(`> ${headline}`);

  if (total > 0) {
    lines.push("");
    lines.push("| Severity | Location | Finding |");
    lines.push("|:--|:--|:--|");
    const sorted = sortBySeverity(report.findings);
    for (const finding of sorted.slice(0, MAX_SUMMARY_ROWS)) {
      const location = `${finding.range.file}:${finding.range.startLine}`;
      lines.push(`| \`${finding.severity}\` | \`${escapeTableCell(location)}\` | **${escapeTableCell(finding.title)}** |`);
    }
    if (sorted.length > MAX_SUMMARY_ROWS) {
      lines.push("");
      lines.push(`And ${sorted.length - MAX_SUMMARY_ROWS} more finding(s); see the full report.`);
    }
  }

  if (summaryOnly.length > 0) {
    lines.push("");
    lines.push(`### Not shown inline (${summaryOnly.length})`);
    lines.push("");
    lines.push("| Location | Finding | Reason |");
    lines.push("|:--|:--|:--|");
    for (const entry of summaryOnly.slice(0, MAX_SUMMARY_ROWS)) {
      const location = `${entry.finding.range.file}:${entry.finding.range.startLine}`;
      lines.push(
        `| \`${escapeTableCell(location)}\` | ${escapeTableCell(entry.finding.title)} | ${escapeTableCell(entry.reason)} |`
      );
    }
    if (summaryOnly.length > MAX_SUMMARY_ROWS) {
      lines.push(`| | And ${summaryOnly.length - MAX_SUMMARY_ROWS} more | |`);
    }
  }

  lines.push("");
  lines.push(`<sub>Reviewed at head \`${headSha}\`</sub>`);

  const body = lines.join("\n");
  if (body.length <= MAX_SUMMARY_CHARS) {
    return body;
  }
  return `${body.slice(0, MAX_SUMMARY_CHARS)}\n\nTruncated to fit the comment size limit.`;
}

// GitHub alert type per severity. CAUTION=red, WARNING=amber, NOTE=blue.
const ALERT_BY_SEVERITY: Record<Severity, string> = {
  critical: "CAUTION",
  high: "CAUTION",
  medium: "WARNING",
  low: "NOTE",
  info: "NOTE"
};

/** Highest severity present among the findings, or null when there are none. */
function worstSeverity(findings: Finding[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((finding) => finding.severity === severity)) {
      return severity;
    }
  }
  return null;
}

/** Alert type for a severity; TIP (green) when nothing was found. */
function alertType(severity: Severity | null): string {
  return severity ? ALERT_BY_SEVERITY[severity] : "TIP";
}

function sortBySeverity(findings: Finding[]): Finding[] {
  const rank = new Map(SEVERITY_ORDER.map((severity, index) => [severity, index]));
  return [...findings].sort(
    (a, b) => (rank.get(a.severity) ?? SEVERITY_ORDER.length) - (rank.get(b.severity) ?? SEVERITY_ORDER.length)
  );
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
