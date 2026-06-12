// Post-build steps that tsc cannot do:
// 1. The generated Prisma client mixes .ts sources (compiled by tsc) with
//    plain .js/.wasm/.json runtime artifacts that tsc never emits. Copy
//    everything except plain .ts sources into dist so the built server can
//    import dist/generated/prisma/index.js.
// 2. Keep the CLI entrypoint executable.
import { chmodSync, cpSync } from "node:fs";

cpSync("src/generated/prisma", "dist/generated/prisma", {
  recursive: true,
  filter: (source) => !(source.endsWith(".ts") && !source.endsWith(".d.ts"))
});

chmodSync("dist/cli/index.js", 0o755);
