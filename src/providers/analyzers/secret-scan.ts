import { scanSecrets } from "../../core/redact.js";
import type { AnalyzerSignal } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

/**
 * Test files and fixtures legitimately contain secret-shaped strings (a
 * redaction test needs a fake AWS key; an auth test needs a fake token). A
 * secret here is almost always a fixture, not a leak.
 */
const TEST_PATH = /(^|\/)(tests?|__tests__|__fixtures__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Deterministic secret scanner. Reuses the same patterns as prompt redaction so
 * a secret that would be redacted before a model call is also surfaced as a
 * signal. Reports only line numbers and safe messages, never the secret value.
 *
 * Secrets in test files are downgraded to low severity: still surfaced, but
 * below the default threshold so fixtures do not flood a review as high-
 * severity findings. Secrets in real code stay high.
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
        const severity = TEST_PATH.test(file.path) ? "low" : "high";
        for (const match of scanSecrets(file.content)) {
          signals.push({
            id: `secret-scan:${match.ruleId}:${file.path}:${match.line}`,
            analyzer: "secret-scan",
            ruleId: match.ruleId,
            range: { file: file.path, startLine: match.line, endLine: match.line, diffSide: "right" },
            severity,
            message: match.message,
            evidence: [`Detected at ${file.path}:${match.line}`]
          });
        }
      }

      return signals;
    }
  };
}
