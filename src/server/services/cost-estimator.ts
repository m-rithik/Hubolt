import { getModelInfo } from "./model-catalog.js";
import { GATEWAY_CONFIG } from "./constants.js";

export class CostEstimator {
  estimateCost(provider: string, model: string, estimatedTokens?: number): number {
    const modelInfo = getModelInfo(provider, model);
    if (!modelInfo) return GATEWAY_CONFIG.DEFAULT_FALLBACK_COST;

    const tokens = estimatedTokens || GATEWAY_CONFIG.DEFAULT_REQUEST_TOKENS;

    return (tokens / 1000) * modelInfo.costPer1kTokens;
  }

  calculateTokens(text: string): number {
    return Math.ceil(text.length / GATEWAY_CONFIG.CHARS_PER_TOKEN);
  }

  calculateActualCost(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number {
    const modelInfo = getModelInfo(provider, model);
    if (!modelInfo) return GATEWAY_CONFIG.DEFAULT_FALLBACK_COST;

    return ((promptTokens + completionTokens) / 1000) * modelInfo.costPer1kTokens;
  }
}
