import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { buildIssueDrafts } from "../../integrations/issues.js";
import { buildIssueTargets, createIssuesIn } from "../../integrations/issue-registry.js";
import { SeveritySchema } from "../../types/finding.js";
import { parseReport } from "../../types/reports.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface IssuesCreateOptions {
  from?: string;
  to?: string;
  minSeverity?: string;
  dryRun?: boolean;
  config?: string;
}

export function registerIssuesCommand(program: Command): void {
  const issues = program.command("issues").description("Create tracker issues from a review report.");

  issues
    .command("create")
    .description("Create Jira/ClickUp/Asana issues from a saved review report (explicit, user-triggered).")
    .requiredOption("--from <report.json>", "review report written by hubolt review --json")
    .option("--to <names>", "comma-separated targets (default: all enabled)")
    .option("--min-severity <severity>", "skip findings below this severity (default: medium)")
    .option("--dry-run", "show what would be created without calling any API")
    .option("--config <path>", "config file path")
    .action((options: IssuesCreateOptions) => runSafelyAsync(() => createIssues(options)));
}

async function createIssues(options: IssuesCreateOptions): Promise<void> {
  const minSeverity = parseMinSeverity(options.minSeverity);
  const report = parseReport(readFileSync(options.from!, "utf8"), options.from!);
  const config = resolveSettings({ cwd: process.cwd(), configPath: options.config }).repo;

  const { drafts, truncated } = buildIssueDrafts(report, { minSeverity });
  if (drafts.length === 0) {
    console.log(ui.muted(`No findings at or above "${minSeverity}"; nothing to create.`));
    return;
  }

  let targets = buildIssueTargets(config);
  if (options.to) {
    const wanted = new Set(options.to.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
    const missing = [...wanted].filter((name) => !targets.some((target) => target.name === name));
    if (missing.length > 0) {
      throw new Error(`Not enabled: ${missing.join(", ")}. Enable integrations.${missing[0]} in your config.`);
    }
    targets = targets.filter((target) => wanted.has(target.name));
  }

  if (targets.length === 0) {
    throw new Error("No issue trackers enabled. Enable integrations.jira, integrations.clickup, or integrations.asana.");
  }

  const truncatedNote = truncated ? " (capped)" : "";
  if (options.dryRun) {
    console.log(ui.section(`Dry run: ${drafts.length} issue(s)${truncatedNote}`, [
      ["Targets", targets.map((target) => target.name).join(", ")],
      ["Min severity", minSeverity]
    ]));
    console.log("");
    console.log(ui.grid(["Severity", "Title"], drafts.map((draft) => [draft.severity, draft.title])));
    return;
  }

  for (const target of targets) {
    const results = await createIssuesIn(target, drafts);
    const created = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok);

    console.log(ui.section(`${target.name}: ${created.length} created, ${failed.length} failed`,
      created.slice(0, 10).map((result) => [result.key ?? "created", result.url ?? "-"])
    ));
    if (failed.length > 0) {
      process.exitCode = 1;
      console.log(ui.error(`${target.name}: ${failed[0].error ?? "creation failed"}`));
    }
  }
}

function parseMinSeverity(value: string | undefined): "info" | "low" | "medium" | "high" | "critical" {
  if (value === undefined) {
    return "medium";
  }
  const parsed = SeveritySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid severity: ${value}. Use info, low, medium, high, or critical.`);
  }
  return parsed.data;
}
