import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

const run = promisify(execFile);

const MANIFEST_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);

interface NpmVulnerability {
  name: string;
  severity: string;
  via?: Array<string | { title?: string; url?: string }>;
  range?: string;
}
interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmVulnerability>;
}

/**
 * Dependency audit analyzer. Runs `npm audit --json` only when a package
 * manifest or lockfile is among the changed files. Network or npm failures
 * degrade to no signals.
 */
export function makeDependencyAuditAnalyzer(): AnalyzerProvider {
  return {
    name: "dependency-audit",
    async isAvailable(ctx: AnalyzerContext): Promise<boolean> {
      return ctx.files.some((file) => MANIFEST_FILES.has(basename(file.path)));
    },
    async analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]> {
      const manifest = ctx.files.map((file) => file.path).find((path) => MANIFEST_FILES.has(basename(path))) ?? "package.json";

      let stdout: string;
      try {
        const result = await run("npm", ["audit", "--json"], {
          cwd: ctx.repoRoot,
          timeout: 120_000,
          maxBuffer: 50 * 1024 * 1024
        });
        stdout = result.stdout;
      } catch (error) {
        // npm audit exits non-zero when vulnerabilities exist; the JSON report is
        // still on stdout. Only a true failure leaves stdout empty.
        stdout = readStdout(error);
        if (!stdout) {
          return [];
        }
      }

      return mapNpmAudit(stdout, manifest);
    }
  };
}

/** Parse `npm audit --json` output into analyzer signals. Pure and unit-testable. */
export function mapNpmAudit(stdout: string, manifestPath: string): AnalyzerSignal[] {
  let report: NpmAuditReport;
  try {
    report = JSON.parse(stdout) as NpmAuditReport;
  } catch {
    return [];
  }

  const signals: AnalyzerSignal[] = [];
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    const titles = (vuln.via ?? [])
      .map((via) => (typeof via === "string" ? via : via.title))
      .filter((title): title is string => Boolean(title));
    const detail = titles[0] ?? `Vulnerable dependency ${vuln.name}`;

    signals.push({
      id: `dependency-audit:${vuln.name}:${vuln.severity}`,
      analyzer: "dependency-audit",
      ruleId: `dependency.${vuln.name}`,
      range: { file: manifestPath, startLine: 1, endLine: 1, diffSide: "right" },
      severity: severityFor(vuln.severity),
      message: `${vuln.name} (${vuln.range ?? "affected"}): ${detail}`,
      evidence: titles.length > 0 ? titles : [`npm audit: ${vuln.name}`]
    });
  }

  return signals;
}

function severityFor(severity: string): Severity {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
      return "medium";
    case "low":
      return "low";
    default:
      return "info";
  }
}

function readStdout(error: unknown): string {
  if (error && typeof error === "object" && "stdout" in error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
  return "";
}
