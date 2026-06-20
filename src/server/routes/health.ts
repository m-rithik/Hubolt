import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  uptime: number;
  database: {
    connected: boolean;
    latencyMs: number;
  };
}

export function registerHealthRoutes(fastify: FastifyInstance, context: ServerContext): void {
  fastify.get<{ Reply: HealthResponse }>("/health", async (request, reply) => {
    const startTime = Date.now();
    let dbConnected = false;
    let dbLatency = 0;

    try {
      await context.db.$queryRaw`SELECT 1`;
      dbLatency = Date.now() - startTime;
      dbConnected = true;
    } catch (error) {
      fastify.log.error(error, "Database health check failed");
    }

    const status = dbConnected ? "ok" : "degraded";
    const response: HealthResponse = {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        connected: dbConnected,
        latencyMs: dbLatency
      }
    };

    reply.status(dbConnected ? 200 : 503).send(response);
  });

  fastify.get("/ready", async (request, reply) => {
    try {
      await context.db.$queryRaw`SELECT 1`;
      reply.status(200).send({ ready: true });
    } catch (error) {
      // This route is public; log the detail server-side but never return raw
      // dependency errors (they can carry hostnames, ports, or SQL fragments).
      fastify.log.error(error, "Readiness check failed");
      reply.status(503).send({ ready: false });
    }
  });
}
