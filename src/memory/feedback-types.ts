/** Shared feedback contracts used by core logic, server, and CLI. */

export type FeedbackVerdict = "accepted" | "dismissed" | "discussed";

export interface FeedbackStats {
  accepted: number;
  dismissed: number;
  discussed: number;
}

export const EMPTY_FEEDBACK_STATS: FeedbackStats = { accepted: 0, dismissed: 0, discussed: 0 };

/** Role breakdown of a fingerprint's dismissals, when role data is known. */
export interface DismissalRoles {
  /** Dismissals from a trusted maintainer role (owner/member/collaborator). */
  byMaintainer: number;
  /** Dismissals whose actor role was recorded at all (maintainer or not). */
  withKnownRole: number;
}

/**
 * Aggregated feedback for a finding, looked up by exact fingerprint first
 * and by rule id as the broader class signal.
 */
export interface FindingFeedbackContext {
  byFingerprint: FeedbackStats;
  byRule: FeedbackStats;
  /** Present only when at least one dismissal carried a known role. */
  fingerprintDismissals?: DismissalRoles;
}

export interface FeedbackEventInput {
  fingerprint: string;
  verdict: FeedbackVerdict;
  source: string;
  externalId?: string;
  actor?: string;
  /** Actor's repo role (e.g. GitHub author_association), when known. */
  role?: string;
  note?: string;
}

/**
 * Roles we treat as maintainers for suppression weighting. GitHub
 * author_association values; anything else (CONTRIBUTOR, NONE, ...) is not
 * trusted to single-handedly silence a finding class.
 */
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isMaintainerRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && MAINTAINER_ROLES.has(role.toUpperCase());
}
