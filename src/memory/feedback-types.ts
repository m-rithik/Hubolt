/** Shared feedback contracts used by core logic, server, and CLI. */

export type FeedbackVerdict = "accepted" | "dismissed" | "discussed";

export interface FeedbackStats {
  accepted: number;
  dismissed: number;
  discussed: number;
}

export const EMPTY_FEEDBACK_STATS: FeedbackStats = { accepted: 0, dismissed: 0, discussed: 0 };

/**
 * Aggregated feedback for a finding, looked up by exact fingerprint first
 * and by rule id as the broader class signal.
 */
export interface FindingFeedbackContext {
  byFingerprint: FeedbackStats;
  byRule: FeedbackStats;
}

export interface FeedbackEventInput {
  fingerprint: string;
  verdict: FeedbackVerdict;
  source: string;
  externalId?: string;
  actor?: string;
  note?: string;
}
