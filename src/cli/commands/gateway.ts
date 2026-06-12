import type { Command } from "commander";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import {
  resolveServerConnection,
  serverGet,
  ServerRequestError,
  type ServerConnectionOptions
} from "../server-client.js";

interface GatewayStatusResponse {
  status: {
    configuredProviders: Array<{ provider: string; lastUsed: string | null }>;
    queueStatus: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      paused: boolean;
    };
    availableModels: Record<string, Record<string, { available?: boolean }>>;
  };
}

interface BudgetsResponse {
  budgets: Array<{
    provider: string;
    monthlyLimitUsd: number;
    currentMonthCostUsd: number;
    percentageUsed: number;
  }>;
}

interface AuditResponse {
  events: unknown[];
  pagination: { total: number };
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Inspect the hosted LLM gateway.");

  gateway
    .command("test")
    .description("Verify gateway health, model catalog, budgets, and audit logging.")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: ServerConnectionOptions) => {
      return runSafelyAsync(() => runGatewayTest(options));
    });
}

async function runGatewayTest(options: ServerConnectionOptions): Promise<void> {
  const connection = resolveServerConnection(options);
  const failures: string[] = [];

  console.log(ui.title("Gateway test"));
  console.log(`Server: ${connection.serverUrl}`);
  console.log("");

  // Gateway status: providers, queue, models. A 404 means the gateway is
  // disabled on this server (no Redis); report it as a failure since the
  // command exists to verify the gateway specifically.
  try {
    const { status } = await serverGet<GatewayStatusResponse>(connection, "/gateway/status");

    const providers = status.configuredProviders.map((entry) => entry.provider);
    console.log(pass(`Gateway reachable; queue ${status.queueStatus.paused ? "paused" : "running"} ` +
      `(waiting ${status.queueStatus.waiting}, active ${status.queueStatus.active}, ` +
      `completed ${status.queueStatus.completed}, failed ${status.queueStatus.failed})`));

    if (providers.length > 0) {
      console.log(pass(`Provider credentials configured: ${providers.join(", ")}`));
    } else {
      console.log(warn("No provider credentials configured; routing will fail until one is stored"));
    }

    let modelCount = 0;
    for (const models of Object.values(status.availableModels ?? {})) {
      for (const info of Object.values(models ?? {})) {
        if (!info || info.available !== false) {
          modelCount += 1;
        }
      }
    }
    if (modelCount > 0) {
      console.log(pass(`Model catalog lists ${modelCount} routable model(s)`));
    } else {
      failures.push("Model catalog is empty");
    }
  } catch (error) {
    if (error instanceof ServerRequestError && error.statusCode === 404) {
      failures.push("Gateway is not enabled on this server (start it with Redis available)");
    } else {
      failures.push(`Gateway status check failed: ${describe(error)}`);
    }
  }

  // Budgets: enforcement requires at least visibility into configured limits.
  try {
    const { budgets } = await serverGet<BudgetsResponse>(connection, "/budgets");
    if (budgets.length === 0) {
      console.log(warn("No budgets configured; gateway requests will not be cost-capped"));
    } else {
      console.log(pass(`Budgets configured for: ${budgets.map((b) => b.provider).join(", ")}`));
    }
  } catch (error) {
    failures.push(`Budget check failed: ${describe(error)}`);
  }

  // Audit logging: the export endpoint proves events are written and readable.
  try {
    const audit = await serverGet<AuditResponse>(connection, "/audit/export?format=json&limit=1");
    console.log(pass(`Audit log readable (${audit.pagination.total} event(s) stored)`));
  } catch (error) {
    failures.push(`Audit log check failed: ${describe(error)}`);
  }

  console.log("");
  if (failures.length === 0) {
    console.log(ui.success("Gateway test passed"));
    return;
  }

  for (const failure of failures) {
    console.error(ui.error(`FAIL ${failure}`));
  }
  throw new Error(`Gateway test failed with ${failures.length} problem(s)`);
}

function pass(message: string): string {
  return `${ui.success("ok")}    ${message}`;
}

function warn(message: string): string {
  return `${ui.warn("warn")}  ${message}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
