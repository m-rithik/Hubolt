import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import {
  resolveServerConnection,
  serverGetText,
  type ServerConnectionOptions
} from "../server-client.js";

interface AuditExportOptions extends ServerConnectionOptions {
  out?: string;
  format?: string;
  action?: string;
  limit?: string;
}

export function registerAuditCommand(program: Command): void {
  const audit = program
    .command("audit")
    .description("Work with the server audit log.");

  audit
    .command("export")
    .description("Export audit events from a Hubolt server to a file.")
    .option("--out <path>", "output file (default: audit-export-<timestamp>.<format>)")
    .option("--format <format>", "json or csv (default: json)")
    .option("--action <filter>", "filter events by action substring")
    .option("--limit <n>", "maximum events to export (default: 1000, max: 10000)")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: AuditExportOptions) => {
      return runSafelyAsync(() => runAuditExport(options));
    });
}

async function runAuditExport(options: AuditExportOptions): Promise<void> {
  const connection = resolveServerConnection(options);

  const format = options.format ?? "json";
  if (format !== "json" && format !== "csv") {
    throw new Error(`Invalid format: ${format} (expected json or csv)`);
  }

  const limit = options.limit ? Number.parseInt(options.limit, 10) : 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error(`Invalid limit: ${options.limit} (must be 1-10000)`);
  }

  const query = new URLSearchParams({ format, limit: String(limit) });
  if (options.action) {
    query.set("action", options.action);
  }

  const body = await serverGetText(connection, `/audit/export?${query}`);

  let exportedCount: number | null = null;
  if (format === "json") {
    try {
      const parsed = JSON.parse(body) as { events?: unknown[] };
      exportedCount = Array.isArray(parsed.events) ? parsed.events.length : null;
    } catch {
      throw new Error("Server returned an unparseable JSON export");
    }
  }

  const outPath = options.out || `audit-export-${Date.now()}.${format}`;
  await writeFile(outPath, body, "utf8");

  console.log(ui.success("Audit export written"));
  console.log(ui.table([
    ["File", outPath],
    ["Format", format],
    ["Events", exportedCount !== null ? String(exportedCount) : "see file"]
  ]));
}
