import type { Severity } from "../types/finding.js";
import type { SeverityCounts } from "../types/reports.js";

/**
 * The boundary contract for external integrations. Adapters consume an
 * IntegrationEvent and nothing else from the codebase: they never import core
 * review modules. The event carries only a summary and threshold-passing
 * findings, already redacted, so an adapter cannot leak secrets or the full
 * reviewed source to a third party.
 */

export type IntegrationEventKind = "review.completed";

export interface IntegrationFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  category: string;
  file: string;
  lineStart: number;
  lineEnd: number;
}

export interface IntegrationEvent {
  kind: IntegrationEventKind;
  /** Human-readable review scope (for example "pr #41 @ abc123"). */
  scope: string;
  status: "ok" | "blocked";
  mode: string;
  provider: string;
  model: string;
  summary: { total: number; bySeverity: SeverityCounts };
  /** Threshold-passing findings only, redacted and capped for notification. */
  findings: IntegrationFinding[];
  /** True when more findings exist than are listed here. */
  truncated: boolean;
  generatedAt: string;
}

export interface DeliveryResult {
  adapter: string;
  ok: boolean;
  /** Transport status (for example HTTP status) when available. */
  status?: number;
  error?: string;
  /** Whether redaction ran over the payload before it left the process. */
  redacted: boolean;
}

export interface IntegrationAdapter {
  readonly name: string;
  /** True when the required configuration and secrets are present. */
  available(): boolean;
  deliver(event: IntegrationEvent): Promise<DeliveryResult>;
}
