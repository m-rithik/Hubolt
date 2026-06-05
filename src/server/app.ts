import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { PrismaClient } from "../generated/prisma/client.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerOrgRoutes } from "./routes/orgs.js";
import { registerBudgetRoutes } from "./routes/budgets.js";
import { registerRateLimitRoutes } from "./routes/rate-limits.js";
import { errorHandler } from "./middleware/error-handler.js";

export interface ServerContext {
  db: PrismaClient;
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

  registerHealthRoutes(fastify, context);
  registerIngestRoutes(fastify, context);
  registerHistoryRoutes(fastify, context);
  registerAuditRoutes(fastify, context);
  registerOrgRoutes(fastify, context);
  registerBudgetRoutes(fastify, context);
  registerRateLimitRoutes(fastify, context);

  return fastify;
}
