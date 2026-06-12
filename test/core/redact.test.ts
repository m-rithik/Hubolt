import { describe, expect, test } from "vitest";
import { redactSecrets, scanSecrets } from "../../src/core/redact.js";

const REDACTED = "[REDACTED]";
const MOCK_OPENAI_KEY = ["sk", "supersecretvalue1234567890"].join("-");
const MOCK_OPENAI_PROJECT_KEY = ["sk", "proj", "1234567890123456789012345678901234567890"].join("-");
const MOCK_GITHUB_PAT = ["ghp", "0123456789012345678901234567890123ab"].join("_");
const MOCK_JWT = ["eyJhbGciOiJIUzI1NiJ9", "MTIzNDU2Nzg5MGFiY2RlZg", "c2lnbmF0dXJlMTIzNDU2"].join(".");

const names = {
  apiKey: sensitiveName("api", "Key"),
  apiKeyEnv: sensitiveName("api", "KeyEnv"),
  authToken: sensitiveName("auth", "Token"),
  clientSecret: sensitiveName("client", "_secret"),
  myPassword: sensitiveName("my", "_password"),
  password: sensitiveName("pass", "word"),
  redactedSecrets: sensitiveName("redacted", "Secrets"),
  token: sensitiveName("tok", "en")
};

describe("redactSecrets", () => {
  test("redacts secret-like assignments but keeps the key name and line", () => {
    const { text, count } = redactSecrets(constAssignment(names.apiKey, MOCK_OPENAI_KEY));
    expect(text).toBe(constAssignment(names.apiKey, REDACTED));
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("redacts quoted secrets that contain other quote characters", () => {
    const doubleQuoted = redactSecrets(constAssignment(names.myPassword, "password'123"));
    const singleQuoted = redactSecrets(constAssignment(names.clientSecret, 'secret"123', "'"));
    const backtickQuoted = redactSecrets(constAssignment(names.authToken, "token'\"123", "`"));

    expect(doubleQuoted.text).toBe(constAssignment(names.myPassword, REDACTED));
    expect(doubleQuoted.count).toBe(1);
    expect(singleQuoted.text).toBe(constAssignment(names.clientSecret, REDACTED, "'"));
    expect(singleQuoted.count).toBe(1);
    expect(backtickQuoted.text).toBe(constAssignment(names.authToken, REDACTED, "`"));
    expect(backtickQuoted.count).toBe(1);
  });

  test("does not redact public environment variable names", () => {
    const input = [
      fieldAssignment(names.apiKeyEnv, "OPENAI_API_KEY"),
      fieldAssignment(names.apiKeyEnv, "ANTHROPIC_API_KEY"),
      fieldAssignment(names.apiKeyEnv, "GOOGLE_GENERATIVE_AI_API_KEY"),
      fieldAssignment(sensitiveName("password", "EnvVar"), "DATABASE_PASSWORD")
    ].join("\n");

    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("does not treat redaction metadata as a secret field", () => {
    const input = redactionMetadataLine("${redacted.count}");

    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("still redacts real literals assigned to redaction-like field names", () => {
    const { text, count } = redactSecrets(constAssignment(names.redactedSecrets, "secret1234"));

    expect(text).toBe(constAssignment(names.redactedSecrets, REDACTED));
    expect(count).toBe(1);
  });

  test("redacts uppercase values when the field is not an env-var reference", () => {
    const { text, count } = redactSecrets(fieldAssignment(names.password, "MY_SECRET_VALUE"));

    expect(text).toBe(fieldAssignment(names.password, REDACTED));
    expect(count).toBe(1);
  });

  test("still redacts token-shaped values assigned to env-like keys", () => {
    const { text, count } = redactSecrets(fieldAssignment(names.apiKeyEnv, MOCK_OPENAI_KEY));

    expect(text).toBe(fieldAssignment(names.apiKeyEnv, REDACTED));
    expect(count).toBe(1);
  });

  test("does not redact interpolated template references as hardcoded secrets", () => {
    const input = 'authorization: `Bearer ${token}`';

    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("redacts well-known token shapes anywhere in a line", () => {
    const { text } = redactSecrets(wrappedCall(MOCK_GITHUB_PAT));

    expect(text).not.toContain(MOCK_GITHUB_PAT);
    expect(text).toContain(REDACTED);
  });

  test("redacts modern OpenAI project keys", () => {
    const { text, count } = redactSecrets(constAssignment("key", MOCK_OPENAI_PROJECT_KEY));

    expect(text).toBe(constAssignment("key", REDACTED));
    expect(count).toBe(1);
  });

  test("redacts jwt values even when the payload does not start with eyJ", () => {
    const { text, count } = redactSecrets(constAssignment("value", MOCK_JWT));

    expect(text).toBe(constAssignment("value", REDACTED));
    expect(count).toBe(1);
  });

  test("redacts the body of a PEM private key without changing line count", () => {
    const input = [pemMarker("begin", "RSA"), "MIIEowIBAAKCAQEA", "abcdEFGH", pemMarker("end", "RSA")].join("\n");
    const { text } = redactSecrets(input);
    const lines = text.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("BEGIN RSA PRIVATE KEY");
    expect(lines[1]).toBe(REDACTED);
    expect(lines[2]).toBe(REDACTED);
    expect(lines[3]).toContain("END RSA PRIVATE KEY");
  });

  test("redacts PEM material on begin and end marker lines", () => {
    const input = [
      `${pemMarker("begin")}MIIEvg`,
      "body",
      `tail${pemMarker("end")}`,
      "const total = price * quantity;"
    ].join("\n");

    const { text, count } = redactSecrets(input);
    const lines = text.split("\n");
    expect(count).toBe(3);
    expect(lines[0]).toBe(`${pemMarker("begin")}${REDACTED}`);
    expect(lines[1]).toBe(REDACTED);
    expect(lines[2]).toBe(`${REDACTED}${pemMarker("end")}`);
    expect(lines[3]).toBe("const total = price * quantity;");
  });

  test("redacts inline PEM blocks without redacting following lines", () => {
    const input = [`${pemMarker("begin")}abc123${pemMarker("end")}`, "const total = price * quantity;"].join("\n");

    const { text, count } = redactSecrets(input);
    const lines = text.split("\n");
    expect(count).toBe(1);
    expect(lines[0]).toBe(`${pemMarker("begin")}${REDACTED}${pemMarker("end")}`);
    expect(lines[1]).toBe("const total = price * quantity;");
  });

  test("leaves ordinary code untouched", () => {
    const input = "const total = price * quantity;";
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("preserves total line count", () => {
    const input = ["line1", constAssignment(names.token, "abcd1234efgh"), "line3"].join("\n");
    expect(redactSecrets(input).text.split("\n")).toHaveLength(3);
  });
});

describe("scanSecrets", () => {
  test("reports the line and rule for a hardcoded credential without the value", () => {
    const input = ["const x = 1;", constAssignment(names.apiKey, MOCK_OPENAI_KEY)].join("\n");
    const matches = scanSecrets(input);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const credential = matches.find((match) => match.line === 2);
    expect(credential?.ruleId).toBeDefined();
    for (const match of matches) {
      expect(match.message).not.toContain("supersecret");
    }
  });

  test("reports modern OpenAI project keys without the value", () => {
    const matches = scanSecrets(constAssignment("key", MOCK_OPENAI_PROJECT_KEY));

    expect(matches).toContainEqual({
      line: 1,
      ruleId: "secret.openai-key",
      message: "Possible OpenAI API key detected."
    });
    for (const match of matches) {
      expect(match.message).not.toContain(MOCK_OPENAI_PROJECT_KEY);
    }
  });

  test("does not report redaction metadata as a hardcoded credential", () => {
    expect(scanSecrets(redactionMetadataLine("${redacted.count}"))).toEqual([]);
  });

  test("still reports real literals assigned to redaction-like field names", () => {
    expect(scanSecrets(constAssignment(names.redactedSecrets, "secret1234"))).toEqual([
      {
        line: 1,
        ruleId: "secret.hardcoded-credential",
        message: `Possible hardcoded secret assigned to "${names.redactedSecrets}".`
      }
    ]);
  });

  test("does not report interpolated template references as hardcoded secrets", () => {
    expect(scanSecrets('headers.authorization = `Bearer ${key}`;')).toEqual([]);
  });

  test("flags a private key body on the right line", () => {
    const input = ["a", pemMarker("begin", "RSA"), "MIIEowIBAAKCAQEA", pemMarker("end", "RSA")].join("\n");
    const matches = scanSecrets(input);
    expect(matches).toEqual([{ line: 3, ruleId: "secret.private-key", message: "Private key material detected." }]);
  });

  test("flags PEM material on begin and end marker lines", () => {
    const input = [
      `${pemMarker("begin")}MIIEvg`,
      "body",
      `tail${pemMarker("end")}`,
      "const total = price * quantity;"
    ].join("\n");

    expect(scanSecrets(input)).toEqual([
      { line: 1, ruleId: "secret.private-key", message: "Private key material detected." },
      { line: 2, ruleId: "secret.private-key", message: "Private key material detected." },
      { line: 3, ruleId: "secret.private-key", message: "Private key material detected." }
    ]);
  });

  test("flags multiple inline private keys without regex state leakage", () => {
    const input = [
      `${pemMarker("begin")}abc123${pemMarker("end")}`,
      `${pemMarker("begin")}def456${pemMarker("end")}`
    ].join("\n");

    expect(scanSecrets(input)).toEqual([
      { line: 1, ruleId: "secret.private-key", message: "Private key material detected." },
      { line: 2, ruleId: "secret.private-key", message: "Private key material detected." }
    ]);
  });

  test("returns nothing for ordinary code", () => {
    expect(scanSecrets("const total = price * quantity;")).toEqual([]);
  });
});

function sensitiveName(...parts: string[]): string {
  return parts.join("");
}

function constAssignment(name: string, value: string, quote = '"'): string {
  return `const ${name} = ${quote}${value}${quote};`;
}

function fieldAssignment(name: string, value: string, quote = '"'): string {
  return `${name}: ${quote}${value}${quote}`;
}

function redactionMetadataLine(value: string): string {
  return `headerParts.push(\`${names.redactedSecrets}="${value}"\`);`;
}

function wrappedCall(value: string): string {
  return `call('${value}')`;
}

function pemMarker(edge: "begin" | "end", prefix = ""): string {
  return `-----${edge.toUpperCase()}${prefix ? ` ${prefix}` : ""} PRIVATE KEY-----`;
}
