import { registerAnalyzerProvider } from "./registry.js";
import { makeSecretScanAnalyzer } from "./secret-scan.js";
import { makeTypeScriptAnalyzer } from "./typescript.js";

registerAnalyzerProvider("secret-scan", makeSecretScanAnalyzer);
registerAnalyzerProvider("typescript", makeTypeScriptAnalyzer);

export { getAnalyzerProvider, listAnalyzerProviders, registerAnalyzerProvider } from "./registry.js";
export { makeSecretScanAnalyzer } from "./secret-scan.js";
export { makeTypeScriptAnalyzer } from "./typescript.js";
