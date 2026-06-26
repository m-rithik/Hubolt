import { PrismaClient } from "../../generated/prisma/index.js";
import { CredentialManager } from "./credential-manager.js";
import { ModelRouter, type RoutingResult } from "./model-router.js";
import { RequestQueue, type QueuedRequest } from "./request-queue.js";
import { BudgetService } from "./budget.js";
import { BudgetManager } from "./budget-manager.js";
import { CostEstimator } from "./cost-estimator.js";
import { GatewayLogger } from "./gateway-logger.js";
import { InputValidator } from "./validation.js";
import { GATEWAY_CONFIG } from "./constants.js";
import { GatewayError } from "./errors.js";
import { ValidationError } from "./validation.js";
import { QueuedRequestResponse, isValidQueuedResponse, extractActualCost } from "./types.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import type { RedisClient } from "../redis.js";
import { createHash } from "node:crypto";

export interface GatewayRequest {
  orgId: string;
  reviewContext: {
    scope: string;
    estimatedTokens?: number;
  };
  system: string;
  user: string;
  overrideProvider?: string;
  overrideModel?: string;
}

export interface GatewayResponse {
  findings: unknown[];
  metadata: {
    provider: string;
    model: string;
    tokensUsed: number;
    estimatedCost: number;
    cached: boolean;
    duration: number;
  };
}

type BudgetReservationPreparation = { status: "prepared" } | { status: "reusable"; jobId: string };

const RESERVATION_PREPARE_WAIT_ATTEMPTS = 20;
const RESERVATION_PREPARE_WAIT_MS = 50;
const RESERVATION_STALE_MS = GATEWAY_CONFIG.JOB_TIMEOUT_MS;

export class LLMGateway {
  private credentialManager: CredentialManager;
  private modelRouter: ModelRouter;
  private requestQueue: RequestQueue;
  private budgetService: BudgetService;
  private budgetManager: BudgetManager;
  private costEstimator: CostEstimator;
  private logger: GatewayLogger;
  private validator: InputValidator;

  constructor(private db: PrismaClient, private redis: RedisClient) {
    this.credentialManager = new CredentialManager(db);
    this.modelRouter = new ModelRouter(db);
    this.requestQueue = new RequestQueue(redis);
    this.budgetService = new BudgetService(db);
    this.budgetManager = new BudgetManager(db);
    this.costEstimator = new CostEstimator();
    this.logger = new GatewayLogger(db);
    this.validator = new InputValidator();
  }

  async init(): Promise<void> {
    await this.requestQueue.init(
      (req) => this.processQueuedRequest(req),
      {
        onCompleted: (jobId, result) => this.settleCompletedJob(jobId, result),
        onFailed: (jobId) => this.settleFailedJob(jobId)
      }
    );
  }

  private async routeWithBudgetContext(request: GatewayRequest): Promise<RoutingResult> {
    const routingRequest = {
      orgId: request.orgId,
      reviewScope: request.reviewContext.scope,
      estimatedTokens: request.reviewContext.estimatedTokens
    };

    const initialRouting = await this.modelRouter.route(routingRequest);
    const selectedProvider = request.overrideProvider || initialRouting.provider;
    const budget = await this.budgetService.checkBudget(request.orgId, selectedProvider, 0);

    if (budget.monthlyLimit <= 0) {
      return initialRouting;
    }

    return this.modelRouter.route({
      ...routingRequest,
      currentBudgetUsed: budget.currentCost,
      totalBudget: budget.monthlyLimit
    });
  }

  async processRequest(request: GatewayRequest): Promise<GatewayResponse> {
    const startTime = Date.now();

    try {
      this.validator.validateOrgId(request.orgId);
      this.validator.validateRequestScope(request.reviewContext.scope);
      this.validator.validatePrompt(request.system, 1);
      this.validator.validatePrompt(request.user, 1);

      if (request.reviewContext.estimatedTokens !== undefined) {
        this.validator.validateTokens(request.reviewContext.estimatedTokens);
      }

      this.validateModelOverrides(request);

      // When the client pins both provider and model, routing would be
      // computed and then discarded; skip the two routing queries. Budget
      // enforcement still happens at reservation time below.
      const routing: RoutingResult =
        request.overrideProvider && request.overrideModel
          ? {
              provider: request.overrideProvider,
              model: request.overrideModel,
              reason: "Client override"
            }
          : await this.routeWithBudgetContext(request);

      const provider = request.overrideProvider || routing.provider;
      const model = request.overrideModel || routing.model;
      this.validateRoutedModel(provider, model);

      // Existence/availability check only; the worker touches lastUsedAt when
      // it actually uses the credential, so don't touch it twice per request.
      const credential = await this.credentialManager.getCredential(request.orgId, provider, {
        touchLastUsed: false
      });
      if (!credential) {
        throw new GatewayError(
          `No credentials configured for provider: ${provider}`,
          400
        );
      }

      const promptHash = this.hashPrompt(JSON.stringify({
        orgId: request.orgId,
        provider,
        model,
        scope: request.reviewContext.scope,
        system: request.system,
        user: request.user
      }));

      const estimatedCostUsd = this.costEstimator.estimateCost(
        provider,
        model,
        request.reviewContext.estimatedTokens
      );

      // An invalid cache entry (corrupt or written by an older schema) is
      // treated as a miss so the request is processed fresh instead of
      // silently answering with zero findings.
      const cachedResult = await this.requestQueue.getCachedResult(promptHash);
      if (isValidQueuedResponse(cachedResult)) {
        return this.buildCachedResponse(provider, model, cachedResult, startTime);
      }

      const reusableJobId = await this.requestQueue.getReusableJobId(promptHash);
      let result: any;

      if (reusableJobId) {
        result = await this.requestQueue.getResult(reusableJobId, GATEWAY_CONFIG.JOB_TIMEOUT_MS);
        return await this.buildQueueResponse(result, request.orgId, provider, model, startTime);
      }

      const reservation = await this.budgetService.reserveUsage(
        request.orgId,
        provider,
        model,
        estimatedCostUsd
      );

      if (!reservation.allowed) {
        throw new GatewayError(
          reservation.reason ?? "Usage limit exceeded",
          reservation.statusCode ?? 429
        );
      }

      const reusableJobIdAfterReservation = await this.requestQueue.getReusableJobId(promptHash);
      if (reusableJobIdAfterReservation) {
        await this.budgetService.refundUsage(request.orgId, provider, estimatedCostUsd);
        await this.refundRateLimitSlot(request.orgId, provider, model);
        result = await this.requestQueue.getResult(reusableJobIdAfterReservation, GATEWAY_CONFIG.JOB_TIMEOUT_MS);
        return await this.buildQueueResponse(result, request.orgId, provider, model, startTime);
      }

      const queuedRequest = this.buildQueuedRequest(request, provider, model, promptHash, estimatedCostUsd);
      let jobId = promptHash;
      let dbReservationCreated = false;
      let budgetRefunded = false;
      let enqueuedSuccessfully = false;

      try {
        if (queuedRequest.budgetReservation) {
          const prepared = await this.preparePersistentBudgetReservation(promptHash, queuedRequest.budgetReservation);
          if (prepared.status === "reusable") {
            await this.budgetService.refundUsage(request.orgId, provider, estimatedCostUsd);
            await this.refundRateLimitSlot(request.orgId, provider, model);
            budgetRefunded = true;
            result = await this.requestQueue.getResult(prepared.jobId, queuedRequest.timeout);
            return await this.buildQueueResponse(result, request.orgId, provider, model, startTime);
          }
          dbReservationCreated = true;
        }

        let enqueued;
        try {
          enqueued = await this.requestQueue.enqueue(queuedRequest);
        } catch (enqueueError) {
          if (queuedRequest.budgetReservation && !budgetRefunded) {
            if (dbReservationCreated) {
              await this.budgetManager.refund(jobId, queuedRequest.budgetReservation);
            } else {
              await this.budgetService.refundUsage(
                queuedRequest.budgetReservation.orgId,
                queuedRequest.budgetReservation.provider,
                queuedRequest.budgetReservation.estimatedCostUsd
              );
            }
            // Enqueue failed, so no provider call happens for this reservation.
            await this.refundRateLimitSlot(request.orgId, provider, model);
          }
          throw enqueueError;
        }

        jobId = enqueued.jobId;
        enqueuedSuccessfully = true;

        if (!enqueued.created) {
          if (queuedRequest.budgetReservation && dbReservationCreated) {
            await this.budgetManager.refund(jobId, queuedRequest.budgetReservation);
          } else {
            await this.budgetService.refundUsage(request.orgId, provider, estimatedCostUsd);
          }
          // Deduplicated onto an existing job: this request triggers no
          // provider call, so release the rate-limit slot it reserved.
          await this.refundRateLimitSlot(request.orgId, provider, model);
          budgetRefunded = true;
        }

        result = await this.requestQueue.getResult(jobId, queuedRequest.timeout);
      } catch (error) {
        if (queuedRequest.budgetReservation && !budgetRefunded && enqueuedSuccessfully && dbReservationCreated && jobId) {
          const isJobActive = await this.isJobActive(jobId);
          if (isJobActive) {
            console.warn(`Job ${jobId} still active despite timeout, deferring refund to settlement handler`);
          } else {
            await this.budgetManager.refund(jobId, queuedRequest.budgetReservation);
          }
        } else if (queuedRequest.budgetReservation && !budgetRefunded && !dbReservationCreated) {
          await this.budgetService.refundUsage(
            queuedRequest.budgetReservation.orgId,
            queuedRequest.budgetReservation.provider,
            queuedRequest.budgetReservation.estimatedCostUsd
          );
        }
        throw error;
      }

      return await this.buildQueueResponse(result, request.orgId, provider, model, startTime);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error("Gateway request failed:", { error, duration });

      if (error instanceof ValidationError) {
        throw new GatewayError(error.message, 400);
      }

      throw error instanceof GatewayError ? error : new GatewayError(
        error instanceof Error ? error.message : "Unknown error",
        500
      );
    }
  }

  private validateModelOverrides(request: GatewayRequest): void {
    if (request.overrideProvider && !request.overrideModel) {
      throw new GatewayError("overrideModel is required when overrideProvider is set", 400);
    }
  }

  private validateRoutedModel(provider: string, model: string): void {
    if (!this.modelRouter.getModelInfo(provider, model)) {
      throw new GatewayError(`Model ${model} is not available for provider ${provider}`, 400);
    }
  }

  private async buildQueueResponse(
    result: any,
    orgId: string,
    provider: string,
    model: string,
    startTime: number
  ): Promise<GatewayResponse> {
    if (!result.success) {
      // Settlement handlers will refund via settleFailedJob
      // Do not refund here to prevent double refunds
      throw new Error(result.error || "Request processing failed");
    }

    if (!isValidQueuedResponse(result.result)) {
      // Settlement handlers will refund via settleFailedJob
      // Do not refund here to prevent double refunds
      throw new Error("Invalid response structure from queue");
    }

    const response = result.result as QueuedRequestResponse;
    const duration = Date.now() - startTime;

    await this.logger.log({
      orgId,
      provider,
      model,
      promptTokens: response.metadata.promptTokens,
      completionTokens: response.metadata.completionTokens,
      estimatedCostUsd: response.metadata.estimatedCostUsd,
      cachedResponse: false,
      duration_ms: duration
    });

    return {
      findings: response.findings,
      metadata: {
        provider,
        model,
        tokensUsed: response.metadata.promptTokens + response.metadata.completionTokens,
        estimatedCost: response.metadata.estimatedCostUsd,
        cached: false,
        duration
      }
    };
  }

  async getStatus(orgId: string) {
    this.validator.validateOrgId(orgId);

    const creds = await this.credentialManager.listCredentials(orgId);
    const stats = await this.requestQueue.getQueueStats();
    const models = this.modelRouter.listAvailableModels();
    const usage = await this.getUsageSummary(orgId);

    return {
      // Bitbucket credentials are stored in the same table but are not LLM
      // providers; keep them out of the gateway's credential view.
      configuredProviders: creds
        .filter((c) => !c.provider.startsWith("bitbucket"))
        .map((c) => ({
          provider: c.provider,
          lastUsed: c.lastUsedAt
        })),
      queueStatus: stats,
      availableModels: models,
      usage
    };
  }

  // Token and cost totals aggregated from the gateway_logs table, broken down
  // per provider. ponytail: one groupBy + JS reduce; promote to a SQL view if
  // the log table grows past what a single aggregate query handles cheaply.
  async getUsageSummary(orgId: string) {
    this.validator.validateOrgId(orgId);

    const groups = await (this.db as any).gatewayLog.groupBy({
      by: ["provider"],
      where: { orgId },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        estimatedCostUsd: true,
        duration_ms: true
      },
      _count: { _all: true }
    });

    const byProvider = groups.map((g: any) => ({
      provider: g.provider,
      requests: g._count?._all ?? 0,
      inputTokens: g._sum?.promptTokens ?? 0,
      outputTokens: g._sum?.completionTokens ?? 0,
      costUsd: g._sum?.estimatedCostUsd ?? 0
    }));

    const totals = byProvider.reduce(
      (acc: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }, p: any, i: number) => {
        acc.requests += p.requests;
        acc.inputTokens += p.inputTokens;
        acc.outputTokens += p.outputTokens;
        acc.costUsd += p.costUsd;
        acc.durationMs += groups[i]._sum?.duration_ms ?? 0;
        return acc;
      },
      { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }
    );

    return {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.inputTokens + totals.outputTokens,
      costUsd: totals.costUsd,
      avgDurationMs: totals.requests > 0 ? Math.round(totals.durationMs / totals.requests) : 0,
      byProvider
    };
  }

  async configureCredential(orgId: string, provider: string, apiKey: string): Promise<void> {
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : apiKey;
    this.validator.validateOrgId(orgId);
    this.validator.validateProvider(provider);
    this.validator.validateApiKey(normalizedApiKey);

    await this.credentialManager.storeCredential(orgId, provider, normalizedApiKey);
  }

  async removeCredential(orgId: string, provider: string): Promise<void> {
    this.validator.validateOrgId(orgId);
    this.validator.validateProvider(provider);

    await this.credentialManager.deleteCredential(orgId, provider);
  }

  private buildCachedResponse(
    provider: string,
    model: string,
    response: QueuedRequestResponse,
    startTime: number
  ): GatewayResponse {
    const duration = Date.now() - startTime;

    return {
      findings: response.findings,
      metadata: {
        provider,
        model,
        tokensUsed: response.metadata.promptTokens + response.metadata.completionTokens,
        estimatedCost: response.metadata.estimatedCostUsd,
        cached: true,
        duration
      }
    };
  }

  private buildQueuedRequest(
    request: GatewayRequest,
    provider: string,
    model: string,
    promptHash: string,
    estimatedCostUsd: number
  ): QueuedRequest {
    const priority = request.reviewContext.scope === "security"
      ? GATEWAY_CONFIG.PRIORITY_SECURITY
      : GATEWAY_CONFIG.PRIORITY_STANDARD;

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      orgId: request.orgId,
      provider,
      model,
      system: request.system,
      user: request.user,
      priority,
      promptHash,
      createdAt: new Date(),
      timeout: GATEWAY_CONFIG.JOB_TIMEOUT_MS,
      budgetReservation: {
        orgId: request.orgId,
        provider,
        estimatedCostUsd,
        status: "reserved"
      }
    };
  }

  private async preparePersistentBudgetReservation(
    jobId: string,
    reservation: NonNullable<QueuedRequest["budgetReservation"]>
  ): Promise<BudgetReservationPreparation> {
    const gatewayBudgetReservation = (this.db as any).gatewayBudgetReservation;
    const existing = await gatewayBudgetReservation.findUnique({
      where: { jobId }
    });

    const data = {
      orgId: reservation.orgId,
      provider: reservation.provider,
      estimatedCostUsd: reservation.estimatedCostUsd,
      actualCostUsd: null,
      status: "reserved",
      settledAt: null
    };

    if (existing) {
      return await this.prepareFromExistingBudgetReservation(gatewayBudgetReservation, jobId, data, existing);
    }

    try {
      await gatewayBudgetReservation.create({
        data: {
          jobId,
          ...data
        }
      });
    } catch (error) {
      if (!this.isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      const concurrentReservation = await gatewayBudgetReservation.findUnique({
        where: { jobId }
      });
      if (!concurrentReservation) {
        throw error;
      }

      return await this.prepareFromExistingBudgetReservation(
        gatewayBudgetReservation,
        jobId,
        data,
        concurrentReservation
      );
    }

    return { status: "prepared" };
  }

  private async prepareFromExistingBudgetReservation(
    gatewayBudgetReservation: any,
    jobId: string,
    data: Record<string, unknown>,
    existing: any
  ): Promise<BudgetReservationPreparation> {
    if (existing.status === "reserved") {
      const reusableJobId = await this.waitForReusableJob(jobId);
      if (reusableJobId) {
        return { status: "reusable", jobId: reusableJobId };
      }

      if (this.isFreshBudgetReservation(existing)) {
        throw new GatewayError("Request reservation is still being prepared", 503);
      }

      await this.budgetManager.refund(jobId, {
        orgId: existing.orgId,
        provider: existing.provider,
        estimatedCostUsd: Number(existing.estimatedCostUsd),
        status: "reserved"
      });
    }

    await gatewayBudgetReservation.update({
      where: { jobId },
      data
    });

    return { status: "prepared" };
  }

  private async waitForReusableJob(jobId: string): Promise<string | null> {
    for (let attempt = 0; attempt < RESERVATION_PREPARE_WAIT_ATTEMPTS; attempt++) {
      const reusableJobId = await this.requestQueue.getReusableJobId(jobId);
      if (reusableJobId) {
        return reusableJobId;
      }

      if (attempt < RESERVATION_PREPARE_WAIT_ATTEMPTS - 1) {
        await this.sleep(RESERVATION_PREPARE_WAIT_MS);
      }
    }

    return null;
  }

  private isFreshBudgetReservation(existing: any): boolean {
    const timestamp = existing.updatedAt ?? existing.createdAt;
    if (!(timestamp instanceof Date)) {
      return true;
    }

    return Date.now() - timestamp.getTime() < RESERVATION_STALE_MS;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2002"
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Pair with budget refunds on paths where this request reserved a slot but
  // then attached to another job (dedup/piggyback) or failed to enqueue, so a
  // request that did no provider work does not keep consuming a rate-limit
  // slot. Best-effort: a failed refund must not change the request outcome.
  private async refundRateLimitSlot(orgId: string, provider: string, model: string): Promise<void> {
    try {
      await this.budgetService.refundRateLimit(orgId, provider, model);
    } catch (error) {
      console.error("Failed to refund rate-limit slot:", error);
    }
  }

  private async settleCompletedJob(jobId: string, rawResult: unknown): Promise<void> {
    try {
      const queued = await this.requestQueue.getQueuedRequest(jobId);
      if (!queued?.budgetReservation) return;

      const actualCost = extractActualCost(rawResult, queued.budgetReservation.estimatedCostUsd);
      await this.budgetManager.reconcileUsage(jobId, queued.budgetReservation, actualCost);
    } catch (error) {
      console.error(`Failed to settle job ${jobId}:`, error);
    }
  }

  private async settleFailedJob(jobId: string): Promise<void> {
    try {
      const terminalFailed = await this.requestQueue.isTerminalFailed(jobId);
      if (!terminalFailed) return;

      const queued = await this.requestQueue.getQueuedRequest(jobId);
      if (!queued?.budgetReservation) return;

      await this.budgetManager.refund(jobId, queued.budgetReservation);
    } catch (error) {
      console.error(`Failed to refund job ${jobId}:`, error);
    }
  }

  private async processQueuedRequest(request: QueuedRequest): Promise<QueuedRequestResponse> {
    const apiKey = await this.credentialManager.getCredential(request.orgId, request.provider);
    if (!apiKey) {
      throw new Error(`No credential for ${request.provider}`);
    }

    const llmProvider = getLLMProvider(request.provider, { model: request.model, apiKey });
    let reportedUsage: { inputTokens: number; outputTokens: number } | undefined;
    const findings = await llmProvider.review({
      system: request.system,
      user: request.user,
      onUsage: (usage) => {
        reportedUsage = usage;
      }
    });

    // Prefer the provider's real token counts; the character-based estimate
    // remains the fallback for providers that report nothing.
    const promptTokens =
      reportedUsage?.inputTokens ??
      this.costEstimator.calculateTokens(request.system) +
        this.costEstimator.calculateTokens(request.user);
    const completionTokens =
      reportedUsage?.outputTokens ?? this.costEstimator.calculateTokens(JSON.stringify(findings));
    const estimatedCostUsd = this.costEstimator.calculateActualCost(
      request.provider,
      request.model,
      promptTokens,
      completionTokens
    );

    return {
      findings,
      metadata: {
        promptTokens,
        completionTokens,
        estimatedCostUsd
      }
    };
  }

  private hashPrompt(prompt: string): string {
    return createHash("sha256").update(prompt).digest("hex");
  }

  private async isJobActive(jobId: string): Promise<boolean> {
    try {
      const job = await this.requestQueue.getJob(jobId);
      if (!job) return false;

      const state = await job.getState();
      // Job is active if it's in 'active', 'waiting', or 'delayed' state
      // Don't refund if the provider might still be processing
      return state === "active" || state === "waiting" || state === "delayed";
    } catch (error) {
      // If we can't check, assume it's active to be safe (don't refund)
      console.error(`Failed to check job state for ${jobId}:`, error);
      return true;
    }
  }

  async close(): Promise<void> {
    await this.requestQueue.close();
  }
}
