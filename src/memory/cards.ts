import type { FeedbackStats } from "./feedback-types.js";

/** A compact memory card: small enough to ride along in a prompt. */
export interface MemoryCardData {
  kind: "rule" | "style";
  repoId: string;
  ruleId: string;
  title: string;
  body: string;
  tokensEstimate: number;
  sourceCount: number;
  pinned: boolean;
}

export interface RuleAggregate {
  ruleId: string;
  repoId: string;
  severitySample: string;
  stats: FeedbackStats;
}

const MIN_EVENTS_FOR_CARD = 3;

export function estimateCardTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build rule-calibration cards from aggregated feedback. Only rules with
 * enough history earn a card; the body states the record plainly so a model
 * reading it knows exactly how the team has voted.
 */
export function buildRuleCards(aggregates: RuleAggregate[]): MemoryCardData[] {
  const cards: MemoryCardData[] = [];

  for (const aggregate of aggregates) {
    const { stats } = aggregate;
    const total = stats.accepted + stats.dismissed;
    if (total + stats.discussed < MIN_EVENTS_FOR_CARD) {
      continue;
    }

    const rate = total > 0 ? Math.round((stats.accepted / total) * 100) : null;
    const stance =
      rate === null ? "discussed but never resolved" :
      rate >= 70 ? "the team acts on this rule; report it confidently" :
      rate <= 20 ? "the team almost always dismisses this rule here; only report clear-cut cases" :
      "mixed reception; report with concrete evidence";

    const body = [
      `rule ${aggregate.ruleId}:`,
      `accepted ${stats.accepted}, dismissed ${stats.dismissed}, discussed ${stats.discussed}` +
        (rate === null ? "" : ` (${rate}% acceptance)`),
      stance
    ].join(" ");

    cards.push({
      kind: "rule",
      repoId: aggregate.repoId,
      ruleId: aggregate.ruleId,
      title: `feedback: ${aggregate.ruleId}`,
      body,
      tokensEstimate: estimateCardTokens(body),
      sourceCount: total + stats.discussed,
      pinned: false
    });
  }

  return cards;
}
