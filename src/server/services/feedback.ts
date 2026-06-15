import { PrismaClient } from "../../generated/prisma/index.js";
import type { FeedbackEventInput } from "../../memory/feedback-types.js";
import { EMPTY_FEEDBACK_STATS, type FeedbackStats } from "../../memory/feedback-types.js";
import type { FeedbackLookup } from "../../memory/apply.js";

export interface IngestFeedbackResult {
  stored: number;
  duplicates: number;
  unknownFingerprints: number;
}

export interface FeedbackIngestScope {
  /** Exact fingerprint attribution is repository-scoped to avoid cross-repo collisions. */
  repoId: string;
}

const VERDICTS = new Set(["accepted", "dismissed", "discussed"]);

export class FeedbackService {
  constructor(private db: PrismaClient) {}

  /**
   * Store feedback events, resolving each fingerprint against the org's
   * stored findings for rule/severity/repo attribution. Events whose
   * fingerprint is unknown are skipped rather than stored unattributed;
   * per-org externalId collisions count as duplicates (idempotent re-imports).
   */
  async ingest(
    orgId: string,
    events: FeedbackEventInput[],
    scope: FeedbackIngestScope
  ): Promise<IngestFeedbackResult> {
    let stored = 0;
    let unknownFingerprints = 0;
    const validEvents: FeedbackEventInput[] = [];

    for (const event of events) {
      if (!VERDICTS.has(event.verdict)) {
        unknownFingerprints += 1;
      } else {
        validEvents.push(event);
      }
    }

    if (validEvents.length === 0) {
      return { stored, duplicates: 0, unknownFingerprints };
    }

    const fingerprints = [...new Set(validEvents.map((event) => event.fingerprint))];
    const findings = await this.db.finding.findMany({
      where: {
        fingerprint: { in: fingerprints },
        orgId,
        repoId: scope.repoId
      },
      orderBy: { createdAt: "desc" }
    });

    const latestByFingerprint = new Map<string, (typeof findings)[number]>();
    for (const finding of findings) {
      if (!latestByFingerprint.has(finding.fingerprint)) {
        latestByFingerprint.set(finding.fingerprint, finding);
      }
    }

    const rows = [];
    for (const event of validEvents) {
      const finding = latestByFingerprint.get(event.fingerprint);
      if (!finding) {
        unknownFingerprints += 1;
        continue;
      }

      rows.push({
        orgId,
        repoId: finding.repoId,
        fingerprint: event.fingerprint,
        ruleId: finding.ruleId,
        severity: finding.severity,
        verdict: event.verdict,
        source: event.source,
        externalId: event.externalId ?? null,
        actor: event.actor ?? null,
        note: event.note ?? null
      });
    }

    if (rows.length === 0) {
      return { stored, duplicates: 0, unknownFingerprints };
    }

    const result = await this.db.findingFeedback.createMany({
      data: rows,
      skipDuplicates: true
    });
    stored = result.count;
    const duplicates = rows.length - stored;

    return { stored, duplicates, unknownFingerprints };
  }

  /** Aggregates for a batch of findings, keyed for applyFeedback. */
  async lookup(
    orgId: string,
    fingerprints: string[],
    ruleIds: string[],
    scope: FeedbackIngestScope
  ): Promise<FeedbackLookup> {
    const byFingerprint = new Map<string, FeedbackStats>();
    const byRule = new Map<string, FeedbackStats>();

    if (fingerprints.length > 0) {
      const rows = await this.db.findingFeedback.groupBy({
        by: ["fingerprint", "verdict"],
        where: {
          orgId,
          fingerprint: { in: fingerprints },
          repoId: scope.repoId
        },
        _count: { _all: true }
      });
      for (const row of rows) {
        accumulate(byFingerprint, row.fingerprint, row.verdict, row._count._all);
      }
    }

    if (ruleIds.length > 0) {
      const rows = await this.db.findingFeedback.groupBy({
        by: ["ruleId", "verdict"],
        where: { orgId, ruleId: { in: ruleIds } },
        _count: { _all: true }
      });
      for (const row of rows) {
        accumulate(byRule, row.ruleId, row.verdict, row._count._all);
      }
    }

    return { byFingerprint, byRule };
  }
}

function accumulate(map: Map<string, FeedbackStats>, key: string, verdict: string, count: number): void {
  const stats = map.get(key) ?? { ...EMPTY_FEEDBACK_STATS };
  if (verdict === "accepted") stats.accepted += count;
  else if (verdict === "dismissed") stats.dismissed += count;
  else if (verdict === "discussed") stats.discussed += count;
  map.set(key, stats);
}
