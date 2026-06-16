import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import { startSpinner } from "../spinner.js";
import { parseReport } from "../../types/reports.js";
import { loadEnv } from "../../config/env.js";
import { createHash } from "node:crypto";

interface PushOptions {
  report: string;
  server?: string;
  apiKey?: string;
  repoFullName?: string;
  repoUrl?: string;
}

export function registerPushReportCommand(program: Command): void {
  program
    .command("push-report")
    .description("Push a review report to a Hubolt server.")
    .requiredOption("--report <path>", "path to JSON report from hubolt review --json")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .option("--repo-full-name <name>", "repository full name (owner/repo), defaults to GITHUB_REPOSITORY or git remote")
    .option("--repo-url <url>", "repository URL, defaults to git remote URL")
    .action((options: PushOptions) => {
      return runSafelyAsync(() => pushReport(options));
    });
}

async function pushReport(options: PushOptions): Promise<void> {
  loadEnv();

  const apiKey = resolveRequiredSecret(options.apiKey, "HUBOLT_API_KEY", "--api-key");
  const serverUrl = resolveRequiredValue(options.server, "HUBOLT_SERVER_URL", "--server").replace(/\/$/, "");

  let report;
  try {
    const content = readFileSync(options.report, "utf8");
    report = parseReport(content, options.report);
  } catch (error) {
    throw new Error(`Failed to parse report: ${String(error)}`);
  }

  let repoFullName = options.repoFullName || process.env.GITHUB_REPOSITORY;
  let repoUrl = options.repoUrl;

  if (!repoFullName || !repoUrl) {
    try {
      const { execSync } = await import("node:child_process");
      if (!repoUrl) {
        repoUrl = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
      }
      if (!repoFullName && repoUrl) {
        const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
        if (match) {
          repoFullName = `${match[1]}/${match[2]}`;
        }
      }
    } catch (error) {
      repoUrl = repoUrl || "https://unknown.repo/repo";
      repoFullName = repoFullName || "unknown/repo";
    }
  }

  repoFullName = repoFullName || "unknown/repo";
  repoUrl = repoUrl || `https://github.com/${repoFullName}`;
  const repoName = repoFullName.split("/")[1] || "repo";

  const findingHashes = report.findings.map((f) => f.fingerprint).sort().join(",");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        repo: repoFullName,
        scope: report.scope,
        generatedAt: report.generatedAt,
        findingCount: report.findings.length,
        findingSignature: findingHashes
      })
    )
    .digest("hex")
    .substring(0, 16);

  const payload = {
    apiKey,
    repository: {
      name: repoName,
      fullName: repoFullName,
      url: repoUrl
    },
    review: {
      fingerprint,
      scope: report.scope,
      provider: report.provider,
      model: report.model,
      summary: report.summary.total > 0 ? `Found ${report.summary.total} findings` : "No findings",
      findingCount: report.findings.length
    },
    findings: report.findings.map((f: any) => ({
      ruleId: f.ruleId,
      message: f.message,
      severity: f.severity,
      category: f.category,
      file: f.range.file,
      lineStart: f.range.startLine,
      lineEnd: f.range.endLine,
      fingerprint: f.fingerprint,
      confidence: f.confidenceLabel === "high" ? 0.9 : f.confidenceLabel === "medium" ? 0.6 : 0.3
    })),
    analyzerSignals: report.analyzerSignals.map((s: any) => ({
      analyzer: s.analyzer,
      ruleId: s.ruleId,
      message: s.message,
      severity: s.severity,
      file: s.range.file,
      lineStart: s.range.startLine,
      lineEnd: s.range.endLine
    })),
    modelUsage: {
      provider: report.provider,
      model: report.model,
      inputTokens: report.modelUsage?.inputTokens ?? 0,
      outputTokens: report.modelUsage?.outputTokens ?? 0,
      estimatedCostUsd: report.modelUsage?.estimatedCostUsd ?? 0
    }
  };

  const spinner = startSpinner(`Pushing report to ${serverUrl}...`);

  try {
    const response = await fetch(`${serverUrl}/ingest/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    spinner.stop();

    if (!response.ok) {
      const errorData = (await response.json()) as any;
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const result = (await response.json()) as any;
    console.log(ui.success(`Report pushed successfully`));
    console.log(ui.muted(`Review ID: ${result.reviewId}`));
  } catch (error) {
    spinner.stop();
    throw new Error(`Failed to push report: ${String(error)}`);
  }
}

function resolveRequiredSecret(value: string | undefined, envName: string, optionName: string): string {
  const resolved = value?.trim() || process.env[envName]?.trim();
  if (!resolved) {
    throw new Error(`Missing API key. Pass ${optionName} or set ${envName}.`);
  }

  return resolved;
}

function resolveRequiredValue(value: string | undefined, envName: string, optionName: string): string {
  const resolved = value?.trim() || process.env[envName]?.trim();
  if (!resolved) {
    throw new Error(`Missing server URL. Pass ${optionName} or set ${envName}.`);
  }

  return resolved;
}
