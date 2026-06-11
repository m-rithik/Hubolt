export interface QueuedRequestMetadata {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export interface QueuedRequestResponse {
  findings: unknown[];
  metadata: QueuedRequestMetadata;
}

export interface CachedRequestResult {
  findings: unknown[];
  metadata?: {
    promptTokens?: number;
    completionTokens?: number;
    estimatedCostUsd?: number;
  };
}

export function isValidQueuedResponse(value: unknown): value is QueuedRequestResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return false;
  if (typeof obj.metadata !== 'object' || obj.metadata === null) return false;

  const metadata = obj.metadata as Record<string, unknown>;
  // Number.isFinite also rejects NaN, which typeof === "number" lets through;
  // a NaN token count or cost would corrupt budget reconciliation downstream.
  return (
    Number.isFinite(metadata.promptTokens) &&
    Number.isFinite(metadata.completionTokens) &&
    Number.isFinite(metadata.estimatedCostUsd)
  );
}

export function extractActualCost(response: unknown, fallback: number): number {
  let obj: any = response;

  // Parse JSON string if necessary
  if (typeof response === 'string') {
    try {
      obj = JSON.parse(response);
    } catch {
      return fallback;
    }
  }

  // Validate structure
  if (!obj || typeof obj !== 'object') return fallback;
  if (typeof obj.metadata !== 'object' || obj.metadata === null) return fallback;

  const metadata = obj.metadata as Record<string, unknown>;
  const cost = metadata.estimatedCostUsd;

  return typeof cost === 'number' && isFinite(cost) && cost >= 0 ? cost : fallback;
}
