import { describe, expect, test } from "vitest";
import { redactSecrets, scanSecrets } from "../../src/core/redact.js";

describe("redactSecrets", () => {
  test("redacts secret-like assignments but keeps the key name and line", () => {
    const { text, count } = redactSecrets('const apiKey = "sk-supersecretvalue1234567890";');
    expect(text).toBe('const apiKey = "[REDACTED]";');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("redacts quoted secrets that contain other quote characters", () => {
    const doubleQuoted = redactSecrets('const my_password = "password\'123";');
    const singleQuoted = redactSecrets("const client_secret = 'secret\"123';");
    const backtickQuoted = redactSecrets("const authToken = `token'\"123`;");

    expect(doubleQuoted.text).toBe('const my_password = "[REDACTED]";');
    expect(doubleQuoted.count).toBe(1);
    expect(singleQuoted.text).toBe("const client_secret = '[REDACTED]';");
    expect(singleQuoted.count).toBe(1);
    expect(backtickQuoted.text).toBe("const authToken = `[REDACTED]`;");
    expect(backtickQuoted.count).toBe(1);
  });

  test("does not redact public environment variable names", () => {
    const input = [
      'apiKeyEnv: "OPENAI_API_KEY"',
      'apiKeyEnv: "ANTHROPIC_API_KEY"',
      'apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY"',
      'passwordEnvVar: "DATABASE_PASSWORD"'
    ].join("\n");

    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("redacts uppercase values when the field is not an env-var reference", () => {
    const { text, count } = redactSecrets('password: "MY_SECRET_VALUE"');

    expect(text).toBe('password: "[REDACTED]"');
    expect(count).toBe(1);
  });

  test("still redacts token-shaped values assigned to env-like keys", () => {
    const { text, count } = redactSecrets('apiKeyEnv: "sk-abcdefghijklmnopqrstuvwxyz123456"');

    expect(text).toBe('apiKeyEnv: "[REDACTED]"');
    expect(count).toBe(1);
  });

  test("redacts well-known token shapes anywhere in a line", () => {
    const { text } = redactSecrets("call('ghp_0123456789012345678901234567890123ab')");
    expect(text).not.toContain("ghp_0123456789012345678901234567890123ab");
    expect(text).toContain("[REDACTED]");
  });

  test("redacts modern OpenAI project keys", () => {
    const key = "sk-proj-1234567890123456789012345678901234567890";
    const { text, count } = redactSecrets(`const key = "${key}";`);

    expect(text).toBe('const key = "[REDACTED]";');
    expect(count).toBe(1);
  });

  test("redacts jwt values even when the payload does not start with eyJ", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.MTIzNDU2Nzg5MGFiY2RlZg.c2lnbmF0dXJlMTIzNDU2";
    const { text, count } = redactSecrets(`const value = "${token}";`);

    expect(text).toBe('const value = "[REDACTED]";');
    expect(count).toBe(1);
  });

  test("redacts the body of a PEM private key without changing line count", () => {
    const input = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "abcdEFGH", "-----END RSA PRIVATE KEY-----"].join(
      "\n"
    );
    const { text } = redactSecrets(input);
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("BEGIN RSA PRIVATE KEY");
    expect(lines[1]).toBe("[REDACTED]");
    expect(lines[2]).toBe("[REDACTED]");
    expect(lines[3]).toContain("END RSA PRIVATE KEY");
  });

  test("redacts PEM material on begin and end marker lines", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----MIIEvg",
      "body",
      "tail-----END PRIVATE KEY-----",
      "const total = price * quantity;"
    ].join("\n");

    const { text, count } = redactSecrets(input);
    const lines = text.split("\n");
    expect(count).toBe(3);
    expect(lines[0]).toBe("-----BEGIN PRIVATE KEY-----[REDACTED]");
    expect(lines[1]).toBe("[REDACTED]");
    expect(lines[2]).toBe("[REDACTED]-----END PRIVATE KEY-----");
    expect(lines[3]).toBe("const total = price * quantity;");
  });

  test("redacts inline PEM blocks without redacting following lines", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----abc123-----END PRIVATE KEY-----",
      "const total = price * quantity;"
    ].join("\n");

    const { text, count } = redactSecrets(input);
    const lines = text.split("\n");
    expect(count).toBe(1);
    expect(lines[0]).toBe("-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----");
    expect(lines[1]).toBe("const total = price * quantity;");
  });

  test("leaves ordinary code untouched", () => {
    const input = "const total = price * quantity;";
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
  });

  test("preserves total line count", () => {
    const input = "line1\nconst token = \"abcd1234efgh\";\nline3";
    expect(redactSecrets(input).text.split("\n")).toHaveLength(3);
  });
});

describe("scanSecrets", () => {
  test("reports the line and rule for a hardcoded credential without the value", () => {
    const input = "const x = 1;\nconst apiKey = \"sk-supersecretvalue1234567890\";";
    const matches = scanSecrets(input);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const credential = matches.find((match) => match.line === 2);
    expect(credential?.ruleId).toBeDefined();
    for (const match of matches) {
      expect(match.message).not.toContain("supersecret");
    }
  });

  test("reports modern OpenAI project keys without the value", () => {
    const key = "sk-proj-1234567890123456789012345678901234567890";
    const matches = scanSecrets(`const key = "${key}";`);

    expect(matches).toContainEqual({
      line: 1,
      ruleId: "secret.openai-key",
      message: "Possible OpenAI API key detected."
    });
    for (const match of matches) {
      expect(match.message).not.toContain(key);
    }
  });

  test("flags a private key body on the right line", () => {
    const input = ["a", "-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n");
    const matches = scanSecrets(input);
    expect(matches).toEqual([{ line: 3, ruleId: "secret.private-key", message: "Private key material detected." }]);
  });

  test("flags PEM material on begin and end marker lines", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----MIIEvg",
      "body",
      "tail-----END PRIVATE KEY-----",
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
      "-----BEGIN PRIVATE KEY-----abc123-----END PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----def456-----END PRIVATE KEY-----"
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
