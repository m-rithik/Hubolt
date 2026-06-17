import type { Severity } from "../types/finding.js";
import type { DeliveryResult, IntegrationAdapter, IntegrationEvent } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface SlackAdapterOptions {
  /** Incoming-webhook URL; undefined when the secret is not configured. */
  webhookUrl: string | undefined;
  /** Findings below this severity are summarized but not listed. */
  minSeverity: Severity;
  fetchImpl?: typeof fetch;
}

/**
 * Slack incoming-webhook adapter. Posts exactly one message per review (a
 * batched summary plus a capped list of notable findings), never one message
 * per finding. The webhook URL is a secret and is only ever sent to Slack.
 */
export function createSlackAdapter(options: SlackAdapterOptions): IntegrationAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "slack",
    available() {
      return Boolean(options.webhookUrl);
    },
    async deliver(event: IntegrationEvent): Promise<DeliveryResult> {
      if (!options.webhookUrl) {
        return { adapter: "slack", ok: false, error: "missing webhook URL", redacted: true };
      }

      const text = buildSlackText(event, options.minSeverity);
      try {
        const response = await fetchImpl(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text })
        });
        return {
          adapter: "slack",
          ok: response.ok,
          status: response.status,
          redacted: true,
          ...(response.ok ? {} : { error: `Slack responded ${response.status}` })
        };
      } catch (error) {
        return {
          adapter: "slack",
          ok: false,
          error: error instanceof Error ? error.message : "request failed",
          redacted: true
        };
      }
    }
  };
}

/** Build the single mrkdwn message body. Pure, so the format is unit-tested. */
export function buildSlackText(event: IntegrationEvent, minSeverity: Severity): string {
  const floor = SEVERITY_RANK[minSeverity];
  const listed = event.findings.filter((finding) => SEVERITY_RANK[finding.severity] >= floor);
  const counts = event.summary.bySeverity;

  const lines = [
    `*Hubolt review* - ${event.scope}`,
    `Status: ${event.status} | ${event.summary.total} finding(s): ` +
      `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ` +
      `${counts.low} low, ${counts.info} info`
  ];

  if (listed.length > 0) {
    lines.push("");
    for (const finding of listed) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart})`);
    }
    if (event.truncated) {
      lines.push("- ...and more in the full report");
    }
  }

  return lines.join("\n");
}
