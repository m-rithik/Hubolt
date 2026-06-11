import { PrismaClient } from "../../generated/prisma/index.js";
import { BudgetExceededError } from "./errors.js";
import {
  MODEL_CATALOG,
  getModelInfo,
  listAvailableModels,
  type ModelInfo,
  type ProviderName
} from "./model-catalog.js";

export { MODEL_CATALOG, type ModelInfo } from "./model-catalog.js";

export interface ModelRoutingRule {
  orgId: string;
  reviewScope: string;
  provider: string;
  model: string;
  priority: number;
  costLimit?: number;
}

export interface RoutingRequest {
  orgId: string;
  reviewScope: string;
  estimatedTokens?: number;
  currentBudgetUsed?: number;
  totalBudget?: number;
}

export interface RoutingResult {
  provider: string;
  model: string;
  reason: string;
}

export class ModelRouter {
  constructor(private db: PrismaClient) {}

  async route(request: RoutingRequest): Promise<RoutingResult> {
    const rules = await this.getRoutingRules(request.orgId);

    if (rules.length === 0) {
      return this.selectDefaultModel(request);
    }

    const applicableRule = this.selectApplicableRule(rules, request);

    if (!applicableRule) {
      return this.selectDefaultModel(request);
    }

    const estimatedTokens = request.estimatedTokens || 0;
    const estimatedCost = this.estimateCost(applicableRule.provider, applicableRule.model, estimatedTokens);

    if (this.isBudgetSufficient(estimatedCost, request.currentBudgetUsed, request.totalBudget)) {
      return {
        provider: applicableRule.provider,
        model: applicableRule.model,
        reason: "Custom routing rule applied"
      };
    }

    // The configured model does not fit the remaining budget. Fall back to the
    // cheapest model from the same provider, but only when that model itself
    // still fits; an exhausted budget must reject rather than downgrade.
    const cheapestModel = this.getCheapestModelForProvider(applicableRule.provider);
    if (cheapestModel && cheapestModel.model !== applicableRule.model) {
      const cheapestCost = this.estimateCost(applicableRule.provider, cheapestModel.model, estimatedTokens);
      if (this.isBudgetSufficient(cheapestCost, request.currentBudgetUsed, request.totalBudget)) {
        return {
          provider: applicableRule.provider,
          model: cheapestModel.model,
          reason: "Budget constraint fallback to cheapest model"
        };
      }
    }

    throw new BudgetExceededError(this.getRemainingBudget(request));
  }

  private getCheapestModelForProvider(provider: string): { model: string; costPer1kTokens: number } | null {
    const providerModels = MODEL_CATALOG[provider as ProviderName];
    if (!providerModels) return null;

    let cheapest: { model: string; costPer1kTokens: number } | null = null;

    for (const [modelName, modelInfo] of Object.entries(providerModels)) {
      if (!modelInfo.available) continue;
      if (!cheapest || modelInfo.costPer1kTokens < cheapest.costPer1kTokens) {
        cheapest = { model: modelName, costPer1kTokens: modelInfo.costPer1kTokens };
      }
    }

    return cheapest;
  }

  async setRoutingRule(rule: ModelRoutingRule): Promise<void> {
    try {
      await this.db.modelRoute.upsert({
        where: {
          orgId_reviewScope_provider: {
            orgId: rule.orgId,
            reviewScope: rule.reviewScope,
            provider: rule.provider
          }
        },
        create: {
          orgId: rule.orgId,
          reviewScope: rule.reviewScope,
          provider: rule.provider,
          model: rule.model,
          priority: rule.priority,
          costLimit: rule.costLimit
        },
        update: {
          model: rule.model,
          priority: rule.priority,
          costLimit: rule.costLimit
        }
      });
    } catch (error) {
      throw new Error(`Failed to set routing rule: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async getRoutingRules(orgId: string): Promise<ModelRoutingRule[]> {
    try {
      const rules = await this.db.modelRoute.findMany({
        where: {
          orgId: {
            in: [orgId, "global"]
          }
        },
        orderBy: { priority: "asc" }
      });
      return rules as any;
    } catch (error) {
      return [];
    }
  }

  private selectApplicableRule(rules: ModelRoutingRule[], request: RoutingRequest): ModelRoutingRule | undefined {
    const applicableRules = rules.filter((rule) => rule.reviewScope === request.reviewScope || rule.reviewScope === "all");

    return applicableRules.sort((a, b) => {
      const aScore = this.getRuleSpecificity(a, request);
      const bScore = this.getRuleSpecificity(b, request);

      return bScore - aScore || a.priority - b.priority;
    })[0];
  }

  private getRuleSpecificity(rule: ModelRoutingRule, request: RoutingRequest): number {
    const orgScore = rule.orgId === request.orgId ? 2 : 0;
    const scopeScore = rule.reviewScope === request.reviewScope ? 1 : 0;

    return orgScore + scopeScore;
  }

  private selectDefaultModel(request: RoutingRequest): RoutingResult {
    const isSecurity = request.reviewScope === "security";
    const hasBudgetConstraint = (request.currentBudgetUsed || 0) > (request.totalBudget || Infinity) * 0.8;

    if (isSecurity) {
      return {
        provider: "anthropic",
        model: "claude-opus-4-8",
        reason: "Security review requires most capable model"
      };
    }

    if (hasBudgetConstraint) {
      return {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        reason: "Cost optimization due to budget constraint"
      };
    }

    return {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reason: "Default balanced model (quality/cost)"
    };
  }

  private estimateCost(provider: string, model: string, tokens: number): number {
    const modelInfo = getModelInfo(provider, model);
    if (!modelInfo) return 0;

    return (tokens / 1000) * modelInfo.costPer1kTokens;
  }

  private isBudgetSufficient(cost: number, used: number = 0, total: number = Infinity): boolean {
    return used + cost <= total;
  }

  private getRemainingBudget(request: RoutingRequest): number {
    const total = request.totalBudget ?? 0;
    const used = request.currentBudgetUsed ?? 0;

    return Math.max(total - used, 0);
  }

  getModelInfo(provider: string, model: string): ModelInfo | null {
    return getModelInfo(provider, model);
  }

  listAvailableModels() {
    return listAvailableModels();
  }
}
