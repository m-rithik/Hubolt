import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Serve the static control panel at /ui. The panel is plain HTML, CSS, and ES
 * modules with no build step; assets live in the repository's web/ directory,
 * which sits three levels above this module in both src/ and dist/ layouts.
 */
export function resolveUiRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../../web");
  return existsSync(resolve(root, "index.html")) ? root : null;
}

export async function registerUiRoutes(fastify: FastifyInstance, uiRoot?: string): Promise<void> {
  const root = uiRoot ?? resolveUiRoot();

  if (!root || !existsSync(resolve(root, "index.html"))) {
    fastify.log.warn("Control panel assets not found; /ui is disabled");
    return;
  }

  await fastify.register(fastifyStatic, {
    root,
    prefix: "/ui/",
    index: "index.html"
  });

  fastify.get("/ui", async (_request, reply) => {
    reply.redirect("/ui/", 301);
  });

  // The landing page is the public face at the root; the control panel
  // stays at /ui/. Falls back to redirecting when the landing is absent.
  const landing = resolve(root, "landing/index.html");
  fastify.get("/", async (_request, reply) => {
    if (existsSync(landing)) {
      return reply.type("text/html").sendFile("landing/index.html");
    }
    reply.redirect("/ui/", 302);
  });
}
