import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerUiRoutes, resolveUiRoot } from "../../src/server/routes/ui.js";

describe("control panel routes", () => {
  test("resolves the web asset root from the repository layout", () => {
    const root = resolveUiRoot();
    expect(root).not.toBeNull();
    expect(root).toContain("web");
  });

  test("serves the panel shell at /ui/ and the landing page at /", async () => {
    const app = Fastify({ logger: false });
    await registerUiRoutes(app);

    const page = await app.inject({ method: "GET", url: "/ui/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Hubolt Control Panel");

    const landing = await app.inject({ method: "GET", url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers["content-type"]).toContain("text/html");
    expect(landing.body).toContain("CODE REVIEW");

    const styles = await app.inject({ method: "GET", url: "/ui/styles.css" });
    expect(styles.statusCode).toBe(200);
    expect(styles.headers["content-type"]).toContain("text/css");

    const module = await app.inject({ method: "GET", url: "/ui/js/app.js" });
    expect(module.statusCode).toBe(200);

    const landingCss = await app.inject({ method: "GET", url: "/ui/landing/landing.css" });
    expect(landingCss.statusCode).toBe(200);

    await app.close();
  });

  test("disables /ui gracefully when assets are missing", async () => {
    const app = Fastify({ logger: false });
    await registerUiRoutes(app, undefined);

    const missing = Fastify({ logger: false });
    await expect(
      registerUiRoutes(missing, "/nonexistent-path-for-test")
    ).resolves.toBeUndefined();

    await app.close();
    await missing.close();
  });
});
