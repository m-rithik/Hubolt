import { PrismaClient } from "../../generated/prisma/index.js";
import { buildRuleCards, estimateCardTokens, type MemoryCardData, type RuleAggregate } from "../../memory/cards.js";
import { retrieveCards, type RetrievedCard } from "../../memory/retrieval.js";
import { EMPTY_FEEDBACK_STATS } from "../../memory/feedback-types.js";

export type StoredMemoryCard = MemoryCardData & { id: string; updatedAt: Date };

export interface RebuildResult {
  ruleCards: number;
  removedStale: number;
  styleCardsKept: number;
}

const RETRIEVAL_BUDGET_TOKENS = 1200;
const MEMORY_KEY_SEPARATOR = "\u0000";

export class MemoryService {
  constructor(private db: PrismaClient) {}

  async list(orgId: string, repoId?: string): Promise<StoredMemoryCard[]> {
    const rows = await this.db.memoryCard.findMany({
      where: {
        orgId,
        ...(repoId !== undefined ? { repoId: { in: ["", repoId] } } : {})
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }]
    });
    return rows.map(toCard);
  }

  /**
   * Regenerate rule-calibration cards from stored feedback. Style cards are
   * maintainer-authored (pinned) and survive untouched; rule cards that no
   * longer meet the evidence bar are removed.
   */
  async rebuild(orgId: string): Promise<RebuildResult> {
    const rows = await this.db.findingFeedback.groupBy({
      by: ["ruleId", "repoId", "verdict"],
      where: { orgId },
      _count: { _all: true }
    });

    const aggregates = new Map<string, RuleAggregate>();
    for (const row of rows) {
      const repoId = row.repoId ?? "";
      const key = memoryCardKey(repoId, row.ruleId);
      const aggregate = aggregates.get(key) ?? {
        ruleId: row.ruleId,
        repoId,
        severitySample: "",
        stats: { ...EMPTY_FEEDBACK_STATS }
      };
      if (row.verdict === "accepted") aggregate.stats.accepted += row._count._all;
      else if (row.verdict === "dismissed") aggregate.stats.dismissed += row._count._all;
      else if (row.verdict === "discussed") aggregate.stats.discussed += row._count._all;
      aggregates.set(key, aggregate);
    }

    const cards = buildRuleCards([...aggregates.values()]);
    const keep = new Set(cards.map((card) => memoryCardKey(card.repoId, card.ruleId)));
    const existingRuleCards = await this.db.memoryCard.findMany({
      where: { orgId, kind: "rule" }
    });

    const existingByKey = new Map(
      existingRuleCards.map((row) => [memoryCardKey(row.repoId, row.ruleId), row])
    );
    const cardsToCreate = cards.filter((card) => !existingByKey.has(memoryCardKey(card.repoId, card.ruleId)));
    const cardsToUpdate = cards.filter((card) => existingByKey.has(memoryCardKey(card.repoId, card.ruleId)));
    const staleIds = existingRuleCards
      .filter((row) => !row.pinned && !keep.has(memoryCardKey(row.repoId, row.ruleId)))
      .map((row) => row.id);

    let removedStale = staleIds.length;
    if (cardsToCreate.length > 0 || cardsToUpdate.length > 0 || staleIds.length > 0) {
      await this.db.$transaction(async (tx) => {
        if (cardsToCreate.length > 0) {
          await tx.memoryCard.createMany({
            data: cardsToCreate.map((card) => ({
              orgId,
              repoId: card.repoId,
              kind: "rule",
              ruleId: card.ruleId,
              title: card.title,
              body: card.body,
              tokensEstimate: card.tokensEstimate,
              sourceCount: card.sourceCount
            })),
            skipDuplicates: true
          });
        }

        for (const card of cardsToUpdate) {
          await tx.memoryCard.update({
            where: {
              orgId_repoId_kind_ruleId: {
                orgId,
                repoId: card.repoId,
                kind: "rule",
                ruleId: card.ruleId
              }
            },
            data: {
              title: card.title,
              body: card.body,
              tokensEstimate: card.tokensEstimate,
              sourceCount: card.sourceCount
            }
          });
        }

        if (staleIds.length > 0) {
          const result = await tx.memoryCard.deleteMany({ where: { id: { in: staleIds } } });
          removedStale = result.count;
        }
      });
    }

    const styleCardsKept = await this.db.memoryCard.count({ where: { orgId, kind: "style" } });

    return { ruleCards: cards.length, removedStale, styleCardsKept };
  }

  /** Maintainer-authored style card; slot key derived from the title. */
  async saveStyleCard(
    orgId: string,
    input: { repoId?: string; title: string; body: string }
  ): Promise<StoredMemoryCard> {
    const repoId = input.repoId ?? "";
    const slot = slugify(input.title);
    const row = await this.db.memoryCard.upsert({
      where: { orgId_repoId_kind_ruleId: { orgId, repoId, kind: "style", ruleId: slot } },
      create: {
        orgId,
        repoId,
        kind: "style",
        ruleId: slot,
        title: input.title,
        body: input.body,
        tokensEstimate: estimateCardTokens(input.body),
        sourceCount: 0,
        pinned: true
      },
      update: {
        title: input.title,
        body: input.body,
        tokensEstimate: estimateCardTokens(input.body)
      }
    });
    return toCard(row);
  }

  async deleteCard(orgId: string, id: string): Promise<boolean> {
    const result = await this.db.memoryCard.deleteMany({ where: { id, orgId } });
    return result.count > 0;
  }

  /** Cards for a review prompt, selected by the shared retrieval logic. */
  async retrieve(
    orgId: string,
    repoId: string,
    ruleIds: string[]
  ): Promise<RetrievedCard<StoredMemoryCard>[]> {
    const cards = await this.list(orgId, repoId);
    return retrieveCards(cards, { repoId, ruleIds, budgetTokens: RETRIEVAL_BUDGET_TOKENS });
  }
}

function toCard(row: {
  id: string;
  repoId: string;
  ruleId: string;
  kind: string;
  title: string;
  body: string;
  tokensEstimate: number;
  sourceCount: number;
  pinned: boolean;
  updatedAt: Date;
}): StoredMemoryCard {
  return {
    id: row.id,
    repoId: row.repoId,
    ruleId: row.ruleId,
    kind: row.kind === "style" ? "style" : "rule",
    title: row.title,
    body: row.body,
    tokensEstimate: row.tokensEstimate,
    sourceCount: row.sourceCount,
    pinned: row.pinned,
    updatedAt: row.updatedAt
  };
}

function memoryCardKey(repoId: string, ruleId: string): string {
  return `${repoId}${MEMORY_KEY_SEPARATOR}${ruleId}`;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "card";
}
