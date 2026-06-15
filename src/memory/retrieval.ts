import type { MemoryCardData } from "./cards.js";

export interface RetrievalRequest {
  /** Repository the review runs in; repo-scoped cards win over org-scoped. */
  repoId?: string;
  /** Rule ids present in current analyzer signals or prior findings. */
  ruleIds?: string[];
  /** Token budget for everything retrieved. */
  budgetTokens: number;
}

export interface RetrievedCard<T extends MemoryCardData = MemoryCardData> {
  card: T;
  reason: string;
}

/**
 * Select cards for a prompt under a token budget. Deterministic priority:
 * pinned style cards first (maintainer-authored conventions), then
 * rule cards matching the review's rules, repo scope before org scope,
 * larger evidence base first. Cards that do not fit the remaining budget
 * are skipped, not truncated.
 */
export function retrieveCards<T extends MemoryCardData>(
  cards: T[],
  request: RetrievalRequest
): RetrievedCard<T>[] {
  const ruleSet = new Set(request.ruleIds ?? []);

  const scored = cards
    .map((card) => {
      const repoMatch = card.repoId !== "" && card.repoId === request.repoId;
      const orgScope = card.repoId === "";
      if (!repoMatch && !orgScope) {
        return null; // card belongs to a different repository
      }

      const ruleMatch = card.kind === "rule" && ruleSet.has(card.ruleId);
      if (card.kind === "rule" && (ruleSet.size === 0 || !ruleMatch)) {
        return null; // rule card irrelevant to this review
      }

      let score = 0;
      const reasons: string[] = [];
      if (card.pinned) {
        score += 100;
        reasons.push("pinned style card");
      }
      if (ruleMatch) {
        score += 50;
        reasons.push("matches a rule in this review");
      }
      if (repoMatch) {
        score += 25;
        reasons.push("repository scope");
      } else {
        reasons.push("organization scope");
      }
      score += Math.min(card.sourceCount, 20);

      return { card, score, reason: reasons.join(", ") };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.score - a.score || a.card.title.localeCompare(b.card.title));

  const selected: RetrievedCard<T>[] = [];
  let remaining = request.budgetTokens;
  for (const entry of scored) {
    if (entry.card.tokensEstimate > remaining) {
      continue;
    }
    remaining -= entry.card.tokensEstimate;
    selected.push({ card: entry.card, reason: entry.reason });
  }

  return selected;
}
