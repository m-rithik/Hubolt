import { afterEach, describe, expect, test, vi } from "vitest";
import { CredentialManager } from "../../src/server/services/credential-manager.js";
import { CostEstimator } from "../../src/server/services/cost-estimator.js";
import { GATEWAY_CONFIG } from "../../src/server/services/constants.js";
import { GatewayLogger } from "../../src/server/services/gateway-logger.js";
import { ModelRouter } from "../../src/server/services/model-router.js";

const originalMasterKey = process.env.CREDENTIAL_MASTER_KEY;

afterEach(() => {
  if (originalMasterKey === undefined) {
    delete process.env.CREDENTIAL_MASTER_KEY;
  } else {
    process.env.CREDENTIAL_MASTER_KEY = originalMasterKey;
  }
});

describe("CredentialManager", () => {
  test("stores a one-way API key hash without leaking key fragments", async () => {
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const upsert = vi.fn().mockResolvedValue({});
    const service = new CredentialManager({
      providerCredential: { upsert }
    } as any);
    const sampleCredential = ["unit", "test", "credential", "value"].join("-");

    await service.storeCredential("org_1", "openai", sampleCredential);

    const data = upsert.mock.calls[0][0].create;
    expect(data.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.keyHash).not.toContain(sampleCredential.slice(0, 4));
    expect(data.keyHash).not.toContain(sampleCredential.slice(-4));
    expect(data.encryptedKey).not.toContain(sampleCredential);
  });

  test("deleting missing credentials is idempotent", async () => {
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new CredentialManager({
      providerCredential: { deleteMany }
    } as any);

    await expect(service.deleteCredential("org_1", "openai")).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        provider: "openai"
      }
    });
  });

  test("can retrieve credentials without touching lastUsedAt", async () => {
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const storedRows: Array<{ encryptedKey: string; keyHash: string }> = [];
    const update = vi.fn();
    const store = new CredentialManager({
      providerCredential: {
        upsert: vi.fn(async (args) => {
          storedRows.push(args.create);
          return {};
        })
      }
    } as any);

    await store.storeCredential("org_1", "openai", ["unit", "test", "credential", "read"].join("-"));

    const read = new CredentialManager({
      providerCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "credential_1",
          encryptedKey: storedRows[0].encryptedKey
        }),
        update
      }
    } as any);

    await expect(read.getCredential("org_1", "openai", { touchLastUsed: false })).resolves.toBe(
      ["unit", "test", "credential", "read"].join("-")
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe("GatewayLogger", () => {
  test("does not propagate audit logging failures", async () => {
    const logger = new GatewayLogger({
      gatewayLog: {
        create: vi.fn().mockRejectedValue(new Error("database unavailable"))
      }
    } as any);

    await expect(logger.log({
      orgId: "org_1",
      provider: "openai",
      model: "gpt-4-mini",
      promptTokens: 1,
      completionTokens: 1,
      estimatedCostUsd: 0.01,
      cachedResponse: false,
      duration_ms: 10
    })).resolves.toBeUndefined();
  });
});

describe("CostEstimator", () => {
  test("uses fallback cost for uncataloged actual model usage", () => {
    const estimator = new CostEstimator();

    expect(estimator.calculateActualCost("openai", "future-model", 100, 100)).toBe(
      GATEWAY_CONFIG.DEFAULT_FALLBACK_COST
    );
  });
});

describe("ModelRouter", () => {
  test("prefers org-specific routes over global routes", async () => {
    const router = new ModelRouter({
      modelRoute: {
        findMany: vi.fn().mockResolvedValue([
          {
            orgId: "global",
            reviewScope: "all",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            priority: 0
          },
          {
            orgId: "org_1",
            reviewScope: "standard",
            provider: "openai",
            model: "gpt-4o-mini",
            priority: 10
          }
        ])
      }
    } as any);

    await expect(router.route({
      orgId: "org_1",
      reviewScope: "standard",
      estimatedTokens: 100
    })).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini"
    });
  });

  test("falls back to the cheapest provider model when it still fits the budget", async () => {
    const router = new ModelRouter({
      modelRoute: {
        findMany: vi.fn().mockResolvedValue([
          {
            orgId: "org_1",
            reviewScope: "standard",
            provider: "anthropic",
            model: "claude-opus-4-8",
            priority: 10
          }
        ])
      }
    } as any);

    await expect(router.route({
      orgId: "org_1",
      reviewScope: "standard",
      estimatedTokens: 1000,
      currentBudgetUsed: 0.9985,
      totalBudget: 1
    })).resolves.toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reason: "Budget constraint fallback to cheapest model"
    });
  });

  test("rejects custom route when budget is exhausted and no cheaper model exists", async () => {
    const router = new ModelRouter({
      modelRoute: {
        findMany: vi.fn().mockResolvedValue([
          {
            orgId: "org_1",
            reviewScope: "standard",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            priority: 10
          }
        ])
      }
    } as any);

    await expect(router.route({
      orgId: "org_1",
      reviewScope: "standard",
      estimatedTokens: 1000,
      currentBudgetUsed: 1.05,
      totalBudget: 1
    })).rejects.toMatchObject({
      name: "BudgetExceededError",
      statusCode: 402
    });
  });
});
