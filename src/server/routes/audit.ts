import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated } from "../middleware/auth.js";
import { z } from "zod";

const ExportAuditQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(1000),
  offset: z.coerce.number().int().min(0).default(0)
});

interface AuditEventDTO {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  details: string | null;
  createdAt: string;
}

export function registerAuditRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get<{ Querystring: z.infer<typeof ExportAuditQuerySchema> }>(
    "/audit/export",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const query = ExportAuditQuerySchema.parse(request.query);

        const where: any = { orgId: request.orgId };

        if (query.startDate || query.endDate) {
          where.createdAt = {};
          if (query.startDate) {
            where.createdAt.gte = new Date(query.startDate);
          }
          if (query.endDate) {
            where.createdAt.lte = new Date(query.endDate);
          }
        }

        if (query.action) {
          where.action = { contains: query.action, mode: "insensitive" };
        }

        const events = await context.db.auditEvent.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: query.offset,
          take: query.limit
        });

        const total = await context.db.auditEvent.count({ where });

        const eventDTOs: AuditEventDTO[] = events.map((e: any) => ({
          id: e.id,
          action: e.action,
          resource: e.resource,
          resourceId: e.resourceId,
          details: e.details,
          createdAt: e.createdAt.toISOString()
        }));

        if (query.format === "csv") {
          const csv = auditEventsToCSV(eventDTOs);
          reply
            .header("Content-Type", "text/csv")
            .header("Content-Disposition", `attachment; filename="audit-export-${Date.now()}.csv"`)
            .send(csv);
          return;
        }

        reply.send({
          events: eventDTOs,
          pagination: {
            total,
            limit: query.limit,
            offset: query.offset
          }
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid query parameters",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to export audit logs" });
      }
    }
  );
}

function escapeCSVCell(cell: string): string {
  let escaped = cell.replace(/"/g, '""');

  if (/^[=+\-@]/.test(escaped)) {
    escaped = "'" + escaped;
  }

  return `"${escaped}"`;
}

function auditEventsToCSV(events: AuditEventDTO[]): string {
  const headers = ["ID", "Action", "Resource", "Resource ID", "Details", "Created At"];
  const rows = events.map((e) => [
    e.id,
    e.action,
    e.resource,
    e.resourceId || "",
    e.details || "",
    e.createdAt
  ]);

  const csvHeader = headers.map((h) => escapeCSVCell(h)).join(",");
  const csvRows = rows.map((row) => row.map((cell) => escapeCSVCell(cell)).join(",")).join("\n");

  return `${csvHeader}\n${csvRows}`;
}
