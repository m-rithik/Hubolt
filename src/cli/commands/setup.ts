import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../../config/defaults.js";
import { writeEnvFile } from "../../config/env-file.js";
import { runSafelyAsync } from "../errors.js";
import { Prompter } from "../prompts.js";
import { renderStarterConfig } from "../starter-config.js";
import { ui } from "../ui.js";

interface SetupOptions {
  print?: boolean;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup: save provider, model, and API key to .env; optionally create .hubolt.yml.")
    .option("--print", "print a starter .hubolt.yml instead of running interactive setup")
    .action((options: SetupOptions) => {
      void runSafelyAsync(() => runSetup(options));
    });
}

async function runSetup(options: SetupOptions): Promise<void> {
  if (options.print) {
    console.log(renderStarterConfig());
    return;
  }

  console.log(ui.title("Hubolt setup"));
  console.log(ui.muted("Settings are saved to .env (gitignored). Press Enter to accept defaults."));
  console.log("");

  const prompter = new Prompter();
  try {
    const provider = await prompter.ask("LLM provider", "openai");
    const model = await prompter.ask("LLM model", "gpt-4.1-mini");

    const updates: Record<string, string> = {
      HUBOLT_LLM_PROVIDER: provider,
      HUBOLT_LLM_MODEL: model
    };

    if (provider === "openai") {
      const key = await prompter.askSecret("OPENAI_API_KEY (leave blank to skip)");
      if (key) {
        updates.OPENAI_API_KEY = key;
      } else {
        console.log(ui.muted("Skipped API key; set OPENAI_API_KEY before running review."));
      }
    } else {
      console.log(ui.muted('Note: only the "openai" provider is implemented so far.'));
    }

    writeEnvFile(resolve(process.cwd(), ".env"), updates);
    console.log(ui.success(`Saved ${Object.keys(updates).length} setting(s) to .env`));

    const createYml = await prompter.ask("Create .hubolt.yml? (y/N)", "N");
    if (/^y(es)?$/i.test(createYml)) {
      const ymlPath = resolve(process.cwd(), DEFAULT_CONFIG_FILE);
      if (existsSync(ymlPath)) {
        console.log(ui.muted(`${DEFAULT_CONFIG_FILE} already exists; left unchanged.`));
      } else {
        writeFileSync(ymlPath, renderStarterConfig());
        console.log(ui.success(`Created ${DEFAULT_CONFIG_FILE}`));
      }
    }

    console.log("");
    console.log(ui.muted("Done. Verify with: hubolt config validate"));
  } finally {
    prompter.close();
  }
}
