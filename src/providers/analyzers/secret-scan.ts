import { scanSecrets } from "../../core/redact.js";
import type { AnalyzerSignal } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

/**
 * Deterministic secret scanner. Reuses the same patterns as prompt redaction so
 * a secret that would be redacted before a model call is also surfaced as a
 * signal. Reports only line numbers and safe messages, never the secret value.
 */
export function makeSecretScanAnalyzer(): AnalyzerProvider {
  return {
    name: "secret-scan",
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]> {
      const signals: AnalyzerSignal[] = [];

      for (const file of ctx.files) {
        for (const match of scanSecrets(file.content)) {
          signals.push({
            id: `secret-scan:${match.ruleId}:${file.path}:${match.line}`,
            analyzer: "secret-scan",
            ruleId: match.ruleId,
            range: { file: file.path, startLine: match.line, endLine: match.line, diffSide: "right" },
            severity: "high",
            message: match.message,
            evidence: [`Detected at ${file.path}:${match.line}`]
          });
        }
      }

      return signals;
    }
  };
}
