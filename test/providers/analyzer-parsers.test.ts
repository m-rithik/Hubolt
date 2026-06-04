import { describe, expect, test } from "vitest";
import { mapEslintResults } from "../../src/providers/analyzers/eslint.js";
import { mapSemgrepResults } from "../../src/providers/analyzers/semgrep.js";
import { mapNpmAudit } from "../../src/providers/analyzers/dependency-audit.js";

describe("mapEslintResults", () => {
  test("maps messages to signals with relative paths and severities", () => {
    const signals = mapEslintResults(
      [
        {
          filePath: "/repo/src/a.ts",
          messages: [
            { ruleId: "no-unused-vars", severity: 2, message: "x is unused", line: 3, column: 7, endLine: 3, endColumn: 8 },
            { ruleId: "eqeqeq", severity: 1, message: "use ===", line: 5, column: 1 }
          ]
        }
      ],
      "/repo"
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      analyzer: "eslint",
      ruleId: "eslint.no-unused-vars",
      severity: "medium",
      range: { file: "src/a.ts", startLine: 3, endLine: 3 }
    });
    expect(signals[1].severity).toBe("low");
  });

  test("treats a parse error (null ruleId) as high severity", () => {
    const signals = mapEslintResults(
      [{ filePath: "/repo/src/a.ts", messages: [{ ruleId: null, severity: 2, message: "Parsing error", line: 1 }] }],
      "/repo"
    );
    expect(signals[0].severity).toBe("high");
    expect(signals[0].ruleId).toBe("eslint.parse-error");
  });
});

describe("mapSemgrepResults", () => {
  test("maps results and severities, returns [] on invalid json", () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: "rules.sqli",
          path: "src/db.ts",
          start: { line: 10, col: 3 },
          end: { line: 12, col: 9 },
          extra: { message: "SQL injection", severity: "ERROR" }
        }
      ]
    });

    const signals = mapSemgrepResults(stdout, "/repo");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      analyzer: "semgrep",
      ruleId: "semgrep.rules.sqli",
      severity: "high",
      message: "SQL injection",
      range: { file: "src/db.ts", startLine: 10, endLine: 12 }
    });
    expect(mapSemgrepResults("not json", "/repo")).toEqual([]);
  });
});

describe("mapNpmAudit", () => {
  test("maps npm vulnerabilities to signals with manifest location", () => {
    const stdout = JSON.stringify({
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          range: "<4.17.21",
          via: [{ title: "Prototype pollution in lodash", url: "https://example" }]
        },
        minimist: { name: "minimist", severity: "moderate", range: "<1.2.6", via: ["lodash"] }
      }
    });

    const signals = mapNpmAudit(stdout, "package.json");
    expect(signals).toHaveLength(2);
    const lodash = signals.find((signal) => signal.ruleId === "dependency.lodash");
    expect(lodash).toMatchObject({
      analyzer: "dependency-audit",
      severity: "high",
      range: { file: "package.json", startLine: 1, endLine: 1 }
    });
    expect(lodash?.message).toContain("Prototype pollution");
    expect(signals.find((signal) => signal.ruleId === "dependency.minimist")?.severity).toBe("medium");
  });

  test("returns [] on invalid json", () => {
    expect(mapNpmAudit("oops", "package.json")).toEqual([]);
  });
});
