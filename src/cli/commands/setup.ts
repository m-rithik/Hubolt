import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../../config/defaults.js";
import { ui } from "../ui.js";
import { renderStarterConfig } from "../starter-config.js";

interface SetupOptions {
  write?: boolean;
  force?: boolean;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Print a starter .hubolt.yml, or write one with --write.")
    .option("--write", "write .hubolt.yml in the current directory")
    .option("--force", "overwrite an existing .hubolt.yml (with --write)")
    .action((options: SetupOptions) => {
      const starterConfig = renderStarterConfig();

      if (!options.write) {
        console.log(starterConfig);
        return;
      }

      const target = resolve(process.cwd(), DEFAULT_CONFIG_FILE);
      if (existsSync(target) && !options.force) {
        throw new Error(`${DEFAULT_CONFIG_FILE} already exists. Use --force to overwrite.`);
      }

      writeFileSync(target, starterConfig);
      console.log(ui.section("Hubolt Setup", [["Wrote", DEFAULT_CONFIG_FILE]]));
    });
}
