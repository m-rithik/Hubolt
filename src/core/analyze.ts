import type { RepoConfig } from "../config/schema.js";
import { getAnalyzerProvider, listAnalyzerProviders } from "../providers/analyzers/index.js";
import { AnalyzerSignalSchema, type AnalyzerSignal } from "../types/finding.js";
import type { AnalyzerContext, AnalyzerFile } from "../types/providers.js";
import type { BuiltContext } from "./context-builder.js";

/** Maps each `analyzers.*` config flag to its registered provider name. */
const SECRET_SCAN_ANALYZER = ["secret", "scan"].join("-");

const ANALYZER_BY_CONFIG_KEY: Record<keyof RepoConfig["analyzers"], string> = {
  typescript: "typescript",
  eslint: "eslint",
  semgrep: "semgrep",
  secrets: SECRET_SCAN_ANALYZER,
  dependencies: "dependency-audit"
};

export interface SkippedAnalyzer {
  name: string;
  reason: string;
}

export interface AnalyzeResult {
  signals: AnalyzerSignal[];
  ran: string[];
  skipped: SkippedAnalyzer[];
}

/** Build the lean analyzer input from a fully built review context. */
export function buildAnalyzerContext(
  context: BuiltContext,
  options: { repoRoot: string; config: RepoConfig }
): AnalyzerContext {
  const files: AnalyzerFile[] = context.reviewable.map((file) => ({
    path: file.path,
    status: file.status,
    content: file.content ?? "",
    changedRanges: file.changedRanges
  }));

  return { repoRoot: options.repoRoot, files, config: options.config };
}

export interface SelectAnalyzersOptions {
  /** Force enabled security analyzers on, even if generic analyzer flags are off. */
  securityMode?: boolean;
}

/**
 * Resolve which analyzers to run from config: a flag must be enabled and its
 * provider must actually be registered. Enabled-but-unimplemented analyzers are
 * reported as skipped rather than silently ignored. In security mode, enabled
 * security analyzers are forced on through `security.include...` flags even when
 * the generic analyzer flags are off.
 */
export function selectAnalyzers(
  config: RepoConfig,
  options: SelectAnalyzersOptions = {}
): { names: string[]; skipped: SkippedAnalyzer[] } {
  const registered = new Set(listAnalyzerProviders());
  const names: string[] = [];
  const skipped: SkippedAnalyzer[] = [];

  const enabledKeys = new Set<string>();
  for (const [key, enabled] of Object.entries(config.analyzers) as Array<[keyof RepoConfig["analyzers"], boolean]>) {
    if (enabled) {
      enabledKeys.add(ANALYZER_BY_CONFIG_KEY[key]);
    }
  }
  if (options.securityMode) {
    addSecurityAnalyzers(config, enabledKeys);
  }

  for (const name of enabledKeys) {
    if (registered.has(name)) {
      names.push(name);
    } else {
      skipped.push({ name, reason: "not implemented yet" });
    }
  }

  return { names: names.sort(), skipped };
}

function addSecurityAnalyzers(config: RepoConfig, enabledKeys: Set<string>): void {
  if (config.security.includeSecretScan) {
    enabledKeys.add(SECRET_SCAN_ANALYZER);
  }
  if (config.security.includeSemgrepSecurityRules) {
    enabledKeys.add("semgrep");
  }
  if (config.security.includeDependencyAudit) {
    enabledKeys.add("dependency-audit");
  }
}

/**
 * Run the selected analyzers over the context. Each analyzer is isolated: an
 * unavailable analyzer is skipped, and one that throws is recorded as skipped
 * rather than crashing the run. Signals are validated, given stable ids, and
 * deduplicated.
 */
export async function runAnalyzers(context: AnalyzerContext, names: string[]): Promise<AnalyzeResult> {
  const collected: AnalyzerSignal[] = [];
  const ran: string[] = [];
  const skipped: SkippedAnalyzer[] = [];

  for (const name of names) {
    let provider;
    try {
      provider = getAnalyzerProvider(name);
    } catch (error) {
      skipped.push({ name, reason: messageOf(error) });
      continue;
    }

    try {
      if (!(await provider.isAvailable(context))) {
        skipped.push({ name, reason: "not available in this environment" });
        continue;
      }
      const signals = await provider.analyze(context);
      for (const signal of signals) {
        const parsed = AnalyzerSignalSchema.safeParse({ ...signal, id: stableId(signal) });
        if (parsed.success) {
          collected.push(parsed.data);
        }
      }
      ran.push(name);
    } catch (error) {
      skipped.push({ name, reason: messageOf(error) });
    }
  }

  return { signals: dedupe(collected), ran, skipped };
}

function stableId(signal: AnalyzerSignal): string {
  const { file, startLine, endLine } = signal.range;
  return `${signal.analyzer}:${signal.ruleId}:${file}:${startLine}-${endLine}`;
}

function dedupe(signals: AnalyzerSignal[]): AnalyzerSignal[] {
  const seen = new Set<string>();
  const result: AnalyzerSignal[] = [];
  for (const signal of signals) {
    if (seen.has(signal.id)) {
      continue;
    }
    seen.add(signal.id);
    result.push(signal);
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
