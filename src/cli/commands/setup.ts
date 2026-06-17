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
import { readEnvFile, writeEnvFile } from "../../config/env-file.js";
import { PROVIDERS, getProviderInfo } from "../../providers/llm/catalog.js";
import { runSafelyAsync } from "../errors.js";
import { renderStarterConfig } from "../starter-config.js";

interface SetupOptions {
  print?: boolean;
  useExistingKeys?: boolean;
  rewriteKeys?: boolean;
}

interface ApiKeyChoice {
  value?: string;
  note: string;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup: pick a provider, save model and API key to .env, optionally create .hubolt.yml.")
    .option("--print", "print a starter .hubolt.yml instead of running interactive setup")
    .option("--use-existing-keys", "reuse existing provider API keys without prompting when present")
    .option("--rewrite-keys", "prompt for new provider API keys even when existing keys are present")
    .action((options: SetupOptions) => {
      return runSafelyAsync(() => runSetup(options));
    });
}

async function runSetup(options: SetupOptions): Promise<void> {
  if (options.print) {
    console.log(renderStarterConfig());
    return;
  }

  if (options.useExistingKeys && options.rewriteKeys) {
    throw new Error("Choose either --use-existing-keys or --rewrite-keys, not both.");
  }

  intro("Hubolt setup");

  const envPath = resolve(process.cwd(), ".env");
  const existingEnv = readEnvFile(envPath);
  const existingProvider = providerFromExistingValue(existingValue(existingEnv, "HUBOLT_LLM_PROVIDER"));

  const providerId = await select({
    message: "LLM provider",
    options: PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label })),
    ...(existingProvider ? { initialValue: existingProvider } : {})
  });
  if (isCancel(providerId)) {
    return cancelSetup();
  }

  const provider = getProviderInfo(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${String(providerId)}`);
  }

  const existingModel =
    existingValue(existingEnv, "HUBOLT_LLM_PROVIDER") === provider.id
      ? existingValue(existingEnv, "HUBOLT_LLM_MODEL")
      : undefined;
  const defaultModel = existingModel ?? provider.defaultModel;
  const model = await text({
    message: "Model",
    placeholder: defaultModel,
    defaultValue: defaultModel
  });
  if (isCancel(model)) {
    return cancelSetup();
  }

  const apiKey = await promptApiKey(provider.apiKeyEnv, existingValue(existingEnv, provider.apiKeyEnv), {
    rewriteKeys: Boolean(options.rewriteKeys),
    useExistingKeys: Boolean(options.useExistingKeys)
  });
  if (!apiKey) {
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
  if (apiKey.value) {
    updates[provider.apiKeyEnv] = apiKey.value;
  }

  writeEnvFile(envPath, updates);

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

  const keyNote = ` ${apiKey.note}`;
  outro(`Saved settings to .env.${keyNote}${ymlNote} Verify with: hubolt config validate`);
}

function cancelSetup(): void {
  cancel("Setup cancelled. No changes written.");
}

function existingValue(envFile: Record<string, string>, key: string): string | undefined {
  return process.env[key] ?? envFile[key];
}

function providerFromExistingValue(value: string | undefined): string | undefined {
  return PROVIDERS.some((provider) => provider.id === value) ? value : undefined;
}

async function promptApiKey(
  apiKeyEnv: string,
  existingApiKey: string | undefined,
  options: { rewriteKeys: boolean; useExistingKeys: boolean }
): Promise<ApiKeyChoice | null> {
  if (existingApiKey && options.useExistingKeys) {
    return { note: `Kept existing ${apiKeyEnv}.` };
  }

  if (existingApiKey && !options.rewriteKeys) {
    const action = await select({
      message: `${apiKeyEnv} already exists`,
      options: [
        { value: "keep", label: "Use existing key", hint: "Leave the stored value unchanged." },
        { value: "replace", label: "Replace key", hint: "Enter and save a new value." },
        { value: "skip", label: "Skip key", hint: "Do not write this key." }
      ],
      initialValue: "keep"
    });
    if (isCancel(action)) {
      return null;
    }
    if (action === "keep") {
      return { note: `Kept existing ${apiKeyEnv}.` };
    }
    if (action === "skip") {
      return { note: `Left ${apiKeyEnv} unchanged.` };
    }
  }

  const apiKey = await password({
    message: existingApiKey ? `New ${apiKeyEnv}` : `${apiKeyEnv} (leave blank to skip)`
  });
  if (isCancel(apiKey)) {
    return null;
  }

  if (!apiKey) {
    return existingApiKey
      ? { note: `Left ${apiKeyEnv} unchanged.` }
      : { note: `Set ${apiKeyEnv} before running review.` };
  }

  return { value: apiKey, note: `Saved ${apiKeyEnv}.` };
}
