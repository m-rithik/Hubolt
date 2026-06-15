import type { Command } from "commander";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import { resolveServerConnection, serverGet, type ServerConnectionOptions } from "../server-client.js";

interface HistoryOptions extends ServerConnectionOptions {
  repo?: string;
  limit?: string;
  id?: string;
  trends?: boolean;
  days?: string;
}

interface TrendsResponse {
  days: number;
  reviews: number;
  findings: { total: number; bySeverity: Record<string, number> };
  feedback: { accepted: number; dismissed: number; discussed: number; acceptanceRate: number | null };
  topRules: Array<{
    ruleId: string;
    findings: number;
    accepted: number;
    dismissed: number;
    acceptanceRate: number | null;
  }>;
}

interface ReviewListResponse {
  reviews: Array<{
    id: string;
    repository: string;
    provider: string;
    model: string;
    findingCount: number;
    createdAt: string;
  }>;
  pagination: { total: number; limit: number; offset: number };
}

interface ReviewDetailResponse {
  id: string;
  repository: string;
  scope: string;
  provider: string;
  model: string;
  summary: string | null;
  findingCount: number;
  createdAt: string;
  findings: Array<{
    severity: string;
    ruleId: string;
    file: string;
    lineStart: number;
    message: string;
  }>;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show review history stored on a Hubolt server.")
    .option("--repo <filter>", "filter by repository name (substring match)")
    .option("--limit <n>", "number of reviews to list (default: 20)")
    .option("--id <reviewId>", "show one review in detail instead of the list")
    .option("--trends", "show trend metrics from review and feedback history")
    .option("--days <n>", "trend window in days (default: 30)")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: HistoryOptions) => {
      return runSafelyAsync(() => runHistory(options));
    });
}

async function runHistory(options: HistoryOptions): Promise<void> {
  const connection = resolveServerConnection(options);

  if (options.trends) {
    const days = options.days ? Number.parseInt(options.days, 10) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error(`Invalid days: ${options.days} (must be 1-365)`);
    }

    const trends = await serverGet<TrendsResponse>(connection, `/history/trends?days=${days}`);
    const pct = (value: number | null): string =>
      value === null ? "-" : `${Math.round(value * 100)}%`;

    console.log(ui.section(`Trends, last ${trends.days} day(s)`, [
      ["Reviews", String(trends.reviews)],
      ["Findings", String(trends.findings.total)],
      ["Accepted", String(trends.feedback.accepted)],
      ["Dismissed", String(trends.feedback.dismissed)],
      ["Discussed", String(trends.feedback.discussed)],
      ["Acceptance rate", pct(trends.feedback.acceptanceRate)]
    ]));

    const severities = Object.entries(trends.findings.bySeverity);
    if (severities.length > 0) {
      console.log("");
      console.log(ui.grid(["Severity", "Findings"], severities.map(([sev, n]) => [sev, String(n)])));
    }

    if (trends.topRules.length > 0) {
      console.log("");
      console.log(ui.grid(
        ["Rule", "Findings", "Accepted", "Dismissed", "Acceptance"],
        trends.topRules.map((rule) => [
          rule.ruleId,
          String(rule.findings),
          String(rule.accepted),
          String(rule.dismissed),
          pct(rule.acceptanceRate)
        ])
      ));
    }
    return;
  }

  if (options.id) {
    const review = await serverGet<ReviewDetailResponse>(
      connection,
      `/history/reviews/${encodeURIComponent(options.id)}`
    );

    console.log(ui.section("Review", [
      ["Repository", review.repository],
      ["Scope", review.scope],
      ["Provider", `${review.provider} (${review.model})`],
      ["Created", review.createdAt],
      ["Findings", String(review.findingCount)],
      ["Summary", review.summary ?? "-"]
    ]));

    if (review.findings.length > 0) {
      console.log("");
      console.log(ui.grid(
        ["Severity", "Rule", "Location", "Message"],
        review.findings.map((finding) => [
          finding.severity,
          finding.ruleId,
          `${finding.file}:${finding.lineStart}`,
          finding.message.length > 80 ? `${finding.message.slice(0, 77)}...` : finding.message
        ])
      ));
    }
    return;
  }

  const limit = options.limit ? Number.parseInt(options.limit, 10) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`Invalid limit: ${options.limit} (must be 1-100)`);
  }

  const query = new URLSearchParams({ limit: String(limit) });
  if (options.repo) {
    query.set("repo", options.repo);
  }

  const result = await serverGet<ReviewListResponse>(connection, `/history/reviews?${query}`);

  if (result.reviews.length === 0) {
    console.log(options.repo ? "No reviews match this filter." : "No reviews stored yet.");
    return;
  }

  console.log(ui.title(`Reviews (${result.reviews.length} of ${result.pagination.total})`));
  console.log(ui.grid(
    ["Id", "Repository", "Provider", "Model", "Findings", "Created"],
    result.reviews.map((review) => [
      review.id,
      review.repository,
      review.provider,
      review.model,
      String(review.findingCount),
      review.createdAt
    ])
  ));
  console.log("");
  console.log(ui.muted("Use hubolt history --id <reviewId> for details."));
}
