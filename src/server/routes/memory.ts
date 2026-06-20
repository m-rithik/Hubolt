import { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, requireAdmin } from "../middleware/auth.js";
import { MemoryService } from "../services/memory.js";

const StyleCardSchema = z.object({
  repoId: z.string().max(60).optional(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4000)
});

const ListMemoryCardsQuerySchema = z.object({
  repo: z.string().min(1).max(60).optional()
});

export function registerMemoryRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);
  const memoryService = new MemoryService(context.db);

  fastify.get(
    "/memory/cards",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      try {
        const { repo } = ListMemoryCardsQuerySchema.parse(request.query);
        const cards = await memoryService.list(request.orgId!, repo);
        reply.send({ cards });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid query", details: error.errors });
          return;
        }
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to list memory cards" });
      }
    }
  );

  fastify.post<{ Body: z.infer<typeof StyleCardSchema> }>(
    "/memory/cards",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const body = StyleCardSchema.parse(request.body);
        const card = await memoryService.saveStyleCard(request.orgId!, body);
        reply.status(201).send({ card });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to save style card" });
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/memory/cards/:id",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest & { params: { id: string } }, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const removed = await memoryService.deleteCard(request.orgId!, request.params.id);
        if (!removed) {
          reply.status(404).send({ error: "Card not found" });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to delete memory card" });
      }
    }
  );

  fastify.post(
    "/memory/rebuild",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const result = await memoryService.rebuild(request.orgId!);
        reply.send({ success: true, ...result });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to rebuild memory" });
      }
    }
  );
}
