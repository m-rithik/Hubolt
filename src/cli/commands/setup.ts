import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  password,
  select,
  text
} from "@clack/prompts";
import type { Command } from "commander";
import { DEFAULT_CONFIG_FILE } from "../../config/defaults.js";
import { writeEnvFile } from "../../config/env-file.js";
import { PROVIDERS, getProviderInfo } from "../../providers/llm/catalog.js";
import { runSafelyAsync } from "../errors.js";
import { renderStarterConfig } from "../starter-config.js";

interface SetupOptions {
  print?: boolean;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup: pick a provider, save model and API key to .env, optionally create .hubolt.yml.")
    .option("--print", "print a starter .hubolt.yml instead of running interactive setup")
    .action((options: SetupOptions) => {
      return runSafelyAsync(() => runSetup(options));
    });
}

async function runSetup(options: SetupOptions): Promise<void> {
  if (options.print) {
    console.log(renderStarterConfig());
    return;
  }

  intro("Hubolt setup");

  const providerId = await select({
    message: "LLM provider",
    options: PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))
  });
  if (isCancel(providerId)) {
    return cancelSetup();
  }

  const provider = getProviderInfo(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${String(providerId)}`);
  }

  const model = await text({
    message: "Model",
    placeholder: provider.defaultModel,
    defaultValue: provider.defaultModel
  });
  if (isCancel(model)) {
    return cancelSetup();
  }

  const apiKey = await password({ message: `${provider.apiKeyEnv} (leave blank to skip)` });
  if (isCancel(apiKey)) {
    return cancelSetup();
  }

  const createYml = await confirm({ message: "Create .hubolt.yml?", initialValue: false });
  if (isCancel(createYml)) {
    return cancelSetup();
  }

  const updates: Record<string, string> = {
    HUBOLT_LLM_PROVIDER: provider.id,
    HUBOLT_LLM_MODEL: model
  };
  if (apiKey) {
    updates[provider.apiKeyEnv] = apiKey;
  }

  writeEnvFile(resolve(process.cwd(), ".env"), updates);

  let ymlNote = "";
  if (createYml) {
    const ymlPath = resolve(process.cwd(), DEFAULT_CONFIG_FILE);
    if (existsSync(ymlPath)) {
      ymlNote = ` ${DEFAULT_CONFIG_FILE} already exists; left unchanged.`;
    } else {
      writeFileSync(ymlPath, renderStarterConfig());
      ymlNote = ` Created ${DEFAULT_CONFIG_FILE}.`;
    }
  }

  const keyNote = apiKey ? "" : ` Set ${provider.apiKeyEnv} before running review.`;
  outro(`Saved settings to .env.${keyNote}${ymlNote} Verify with: hubolt config validate`);
}

function cancelSetup(): void {
  cancel("Setup cancelled. No changes written.");
}
