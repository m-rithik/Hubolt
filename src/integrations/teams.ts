import type { Severity } from "../types/finding.js";
import type { DeliveryResult, IntegrationAdapter, IntegrationEvent } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface TeamsAdapterOptions {
  /** Incoming-webhook URL (Teams Workflows / connector); undefined when unset. */
  webhookUrl: string | undefined;
  /** Findings below this severity are summarized but not listed. */
  minSeverity: Severity;
  fetchImpl?: typeof fetch;
}

/**
 * Microsoft Teams incoming-webhook adapter. Posts one Adaptive Card per review
 * (a summary plus a capped list of notable findings), never one per finding.
 * Uses the Workflows message envelope, which is the current Teams webhook
 * format. The webhook URL is a secret and is only ever sent to Teams.
 */
export function createTeamsAdapter(options: TeamsAdapterOptions): IntegrationAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "teams",
    available() {
      return Boolean(options.webhookUrl);
    },
    async deliver(event: IntegrationEvent): Promise<DeliveryResult> {
      if (!options.webhookUrl) {
        return { adapter: "teams", ok: false, error: "missing webhook URL", redacted: true };
      }

      try {
        const response = await fetchImpl(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildTeamsCard(event, options.minSeverity))
        });
        return {
          adapter: "teams",
          ok: response.ok,
          status: response.status,
          redacted: true,
          ...(response.ok ? {} : { error: `Teams responded ${response.status}` })
        };
      } catch (error) {
        return {
          adapter: "teams",
          ok: false,
          error: error instanceof Error ? error.message : "request failed",
          redacted: true
        };
      }
    }
  };
}

/** Build the Adaptive Card message payload. Pure, so the shape is unit-tested. */
export function buildTeamsCard(event: IntegrationEvent, minSeverity: Severity): unknown {
  const floor = SEVERITY_RANK[minSeverity];
  const listed = event.findings.filter((finding) => SEVERITY_RANK[finding.severity] >= floor);
  const counts = event.summary.bySeverity;

  const body: Array<Record<string, unknown>> = [
    { type: "TextBlock", size: "Medium", weight: "Bolder", text: `Hubolt review - ${event.scope}` },
    {
      type: "TextBlock",
      wrap: true,
      text:
        `Status: ${event.status} | ${event.summary.total} finding(s): ` +
        `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ` +
        `${counts.low} low, ${counts.info} info`
    }
  ];

  for (const finding of listed) {
    body.push({
      type: "TextBlock",
      wrap: true,
      text: `- [${finding.severity}] ${finding.title} (${finding.file}:${finding.lineStart})`
    });
  }
  if (listed.length > 0 && event.truncated) {
    body.push({ type: "TextBlock", wrap: true, text: "- ...and more in the full report" });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body
        }
      }
    ]
  };
}
