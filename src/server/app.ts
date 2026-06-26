import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { PrismaClient } from "../generated/prisma/index.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerOrgRoutes } from "./routes/orgs.js";
import { registerBudgetRoutes } from "./routes/budgets.js";
import { registerRateLimitRoutes } from "./routes/rate-limits.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerGatewayRoutes } from "./routes/gateway.js";
import { registerGitHubRepoRoutes } from "./routes/github-repos.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerBitbucketWebhookRoutes } from "./routes/bitbucket-webhooks.js";
import { registerBitbucketConfigRoutes } from "./routes/bitbucket-config.js";
import { errorHandler } from "./middleware/error-handler.js";
import { LLMGateway } from "./services/llm-gateway.js";
import { createReviewJobProducer } from "../queue/review-jobs.js";
import type { RedisClient } from "./redis.js";

export interface ServerContext {
  db: PrismaClient;
  redis?: RedisClient;
}

export async function createApp(context: ServerContext): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: false
        }
      }
    }
  });

  fastify.register(helmet);

  const corsOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? false : "http://localhost:3000");
  fastify.register(cors, {
    origin: corsOrigin
  });

  fastify.setErrorHandler(errorHandler);

  await registerUiRoutes(fastify);

  registerHealthRoutes(fastify, context);
  registerIngestRoutes(fastify, context);
  registerHistoryRoutes(fastify, context);
  registerAuditRoutes(fastify, context);
  registerOrgRoutes(fastify, context);
  registerBudgetRoutes(fastify, context);
  registerRateLimitRoutes(fastify, context);
  registerFeedbackRoutes(fastify, context);
  registerMemoryRoutes(fastify, context);
  registerGitHubRepoRoutes(fastify, context);

  let gateway: LLMGateway | null = null;
  if (context.redis) {
    try {
      gateway = new LLMGateway(context.db, context.redis);
      await gateway.init();
      await registerGatewayRoutes(fastify, gateway, context.db);
      console.log("LLM Gateway initialized");
    } catch (error) {
      if (gateway) {
        await gateway.close();
        gateway = null;
      }
      console.warn("LLM Gateway initialization failed:", error instanceof Error ? error.message : error);
    }
  }

  if (gateway) {
    fastify.addHook("onClose", async () => {
      await gateway.close();
    });
  }

  // The GitHub App delivers webhooks signed with its own secret; a manually
  // configured repo webhook uses the standalone secret. Accept any configured
  // secret so a delivery signed with either one is not rejected when both are
  // set to different values.
  const webhookSecrets = [process.env.GITHUB_WEBHOOK_SECRET, process.env.GITHUB_APP_WEBHOOK_SECRET].filter(
    (value): value is string => Boolean(value)
  );
  if (webhookSecrets.length > 0 && context.redis) {
    const producer = createReviewJobProducer(context.redis);
    registerWebhookRoutes(fastify, context, { secrets: webhookSecrets, producer });
    fastify.addHook("onClose", async () => {
      await producer.close();
    });
    console.log("GitHub webhook ingest enabled");
  } else if (webhookSecrets.length > 0) {
    console.warn("A GitHub webhook secret is set but Redis is unavailable; webhook ingest disabled");
  }

  // Bitbucket integration: webhook ingest (runs reviews) plus dashboard config
  // routes so the API token and webhook secret can be set from the UI. The token
  // and secret are resolved per request from stored config or the environment.
  registerBitbucketWebhookRoutes(fastify, context);
  registerBitbucketConfigRoutes(fastify, context);
  console.log("Bitbucket integration enabled (webhook + dashboard config)");

  return fastify;
}
