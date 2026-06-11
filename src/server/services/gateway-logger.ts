import { PrismaClient } from "../../generated/prisma/index.js";

export interface GatewayLogData {
  orgId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  cachedResponse: boolean;
  duration_ms: number;
}

export class GatewayLogger {
  constructor(private db: PrismaClient) {}

  async log(data: GatewayLogData): Promise<void> {
    try {
      const dbWithGatewayLog = this.db as PrismaClient & { gatewayLog: { create: (args: { data: GatewayLogData }) => Promise<void> } };
      await dbWithGatewayLog.gatewayLog.create({ data });
    } catch (error) {
      console.error("Failed to log gateway request:", error);
    }
  }
}
