import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { renderJsonReport, renderMarkdownReport } from "../../report/index.js";
import { parseReport } from "../../types/reports.js";
import { runSafely } from "../errors.js";
import { ui } from "../ui.js";

interface ReportOptions {
  from?: string;
  md?: string;
  json?: string;
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Render a Markdown or JSON report from a saved JSON report.")
    .requiredOption("--from <path>", "path to a JSON report produced by hubolt review --json")
    .option("--md <path>", "write a Markdown report to this path")
    .option("--json <path>", "write a (re-validated) JSON report to this path")
    .action((options: ReportOptions) => {
      runSafely(() => runReport(options));
    });
}

function runReport(options: ReportOptions): void {
  if (!options.from) {
    throw new Error("Provide --from <path> to a JSON report.");
  }
  if (!options.md && !options.json) {
    throw new Error("Provide --md <path> and/or --json <path> to write.");
  }

  const report = parseReport(readFileSync(options.from, "utf8"), options.from);

  if (options.md) {
    writeFileSync(options.md, renderMarkdownReport(report));
    console.log(ui.muted(`Wrote Markdown report to ${options.md}`));
  }
  if (options.json) {
    writeFileSync(options.json, renderJsonReport(report));
    console.log(ui.muted(`Wrote JSON report to ${options.json}`));
  }
}
