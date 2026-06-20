import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { errorHandler } from "../../src/server/middleware/error-handler.js";

function appThatThrows(error: unknown) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler as any);
  app.get("/boom", async () => {
    throw error;
  });
  return app;
}

describe("global error handler", () => {
  test("hides the message and name of unexpected 5xx errors", async () => {
    const app = appThatThrows(new Error("connect ECONNREFUSED db.internal:5432 password=hunter2"));

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" });
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("hunter2");
    await app.close();
  });

  test("preserves deliberate 4xx client error messages", async () => {
    const app = appThatThrows(Object.assign(new Error("name is required"), { statusCode: 400 }));

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400, message: "name is required" });
    await app.close();
  });
});
