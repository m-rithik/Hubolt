import { describe, expect, test, vi } from "vitest";
import {
  resolveServerConnection,
  serverGet,
  serverGetText,
  ServerRequestError
} from "../../src/cli/server-client.js";

const FIXTURE_KEY = ["unit", "test", "server", "key"].join("-");
const ENV_FIXTURE_KEY = ["env", "server", "key"].join("-");

describe("resolveServerConnection", () => {
  test("flags take precedence and trailing slashes are stripped", () => {
    const env = { HUBOLT_SERVER_URL: "http://env-server:3000", HUBOLT_API_KEY: ENV_FIXTURE_KEY };

    const connection = resolveServerConnection(
      { server: "http://flag-server:3000/", apiKey: FIXTURE_KEY },
      env
    );

    expect(connection).toEqual({ serverUrl: "http://flag-server:3000", apiKey: FIXTURE_KEY });
  });

  test("falls back to environment values", () => {
    const env = { HUBOLT_SERVER_URL: "http://env-server:3000/", HUBOLT_API_KEY: ENV_FIXTURE_KEY };

    expect(resolveServerConnection({}, env)).toEqual({
      serverUrl: "http://env-server:3000",
      apiKey: ENV_FIXTURE_KEY
    });
  });

  test("fails clearly when the server URL or key is missing", () => {
    expect(() => resolveServerConnection({}, {})).toThrow(/HUBOLT_SERVER_URL/);
    expect(() => resolveServerConnection({ server: "http://x:3000" }, {})).toThrow(/HUBOLT_API_KEY/);
  });
});

describe("serverGet", () => {
  const connection = { serverUrl: "http://test-server:3000", apiKey: FIXTURE_KEY };

  test("sends the bearer header and parses JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(serverGet(connection, "/health", fetchImpl)).resolves.toEqual({ ok: true });

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toBe("http://test-server:3000/health");
    expect(init.headers.authorization).toBe(`Bearer ${FIXTURE_KEY}`);
  });

  test("surfaces API error messages with the status code", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Budget not found" }), { status: 404 })
    ) as unknown as typeof fetch;

    const error = await serverGet(connection, "/budgets/x", fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect((error as ServerRequestError).statusCode).toBe(404);
    expect((error as ServerRequestError).message).toBe("Budget not found");
  });

  test("reports unreachable servers without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const error = await serverGet(connection, "/health", fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect((error as ServerRequestError).statusCode).toBe(0);
    expect((error as ServerRequestError).message).not.toContain(FIXTURE_KEY);
  });
});

describe("serverGetText", () => {
  const connection = { serverUrl: "http://test-server:3000", apiKey: FIXTURE_KEY };

  test("returns raw bodies for non-JSON formats", async () => {
    const csv = "id,action\n1,review.ingested\n";
    const fetchImpl = vi.fn(async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;

    await expect(serverGetText(connection, "/audit/export?format=csv", fetchImpl)).resolves.toBe(csv);
  });

  test("extracts error messages from JSON error bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    ) as unknown as typeof fetch;

    const error = await serverGetText(connection, "/audit/export", fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect((error as ServerRequestError).message).toBe("Unauthorized");
  });
});
