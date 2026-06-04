import { registerAnalyzerProvider } from "./registry.js";
import { makeDependencyAuditAnalyzer } from "./dependency-audit.js";
import { makeEslintAnalyzer } from "./eslint.js";
import { makeSecretScanAnalyzer } from "./secret-scan.js";
import { makeSemgrepAnalyzer } from "./semgrep.js";
import { makeTypeScriptAnalyzer } from "./typescript.js";

registerAnalyzerProvider("secret-scan", makeSecretScanAnalyzer);
registerAnalyzerProvider("typescript", makeTypeScriptAnalyzer);
registerAnalyzerProvider("eslint", makeEslintAnalyzer);
registerAnalyzerProvider("semgrep", makeSemgrepAnalyzer);
registerAnalyzerProvider("dependency-audit", makeDependencyAuditAnalyzer);

export { getAnalyzerProvider, listAnalyzerProviders, registerAnalyzerProvider } from "./registry.js";
export { makeSecretScanAnalyzer } from "./secret-scan.js";
export { makeTypeScriptAnalyzer } from "./typescript.js";
export { makeEslintAnalyzer } from "./eslint.js";
export { makeSemgrepAnalyzer } from "./semgrep.js";
export { makeDependencyAuditAnalyzer } from "./dependency-audit.js";
