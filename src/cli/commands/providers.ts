import type { Command } from "commander";
import { loadEnv } from "../../config/env.js";
import { getLLMProvider, getProviderInfo, listLLMProviders, PROVIDERS } from "../../providers/llm/index.js";
import { runSafely, runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface TestOptions {
  model?: string;
}

export function registerProvidersCommand(program: Command): void {
  const providers = program.command("providers").description("List configured LLM providers and test credentials.");

  providers
    .command("list", { isDefault: true })
    .description("List providers, their default model, and whether an API key is present.")
    .action(() => runSafely(runList));

  providers
    .command("test <provider>")
    .description("Test a provider's credentials and structured-output support with a tiny call.")
    .option("--model <model>", "model to test (defaults to the provider's default)")
    .action((provider: string, options: TestOptions) => runSafelyAsync(() => runTest(provider, options)));
}

function runList(): void {
  // Load .env so keys stored there (as `hubolt setup` writes them) are seen,
  // matching how `review` resolves credentials.
  loadEnv();
  const registered = new Set(listLLMProviders());

  const rows = PROVIDERS.map((provider) => [
    provider.id,
    provider.label,
    provider.defaultModel,
    provider.apiKeyEnv,
    process.env[provider.apiKeyEnv] ? ui.success("set") : ui.muted("missing"),
    registered.has(provider.id) ? "yes" : ui.muted("no")
  ]);

  console.log(ui.title("Hubolt Providers"));
  console.log("");
  console.log(ui.grid(["Id", "Label", "Default model", "Key env", "Key", "Registered"], rows));
}

async function runTest(providerId: string, options: TestOptions): Promise<void> {
  loadEnv();
  const info = getProviderInfo(providerId);
  if (!info) {
    throw new Error(`Unknown provider: ${providerId}. Known: ${PROVIDERS.map((provider) => provider.id).join(", ")}.`);
  }

  const model = options.model ?? info.defaultModel;
  if (!process.env[info.apiKeyEnv]) {
    throw new Error(`${info.label}: API key not set. Export ${info.apiKeyEnv} and retry.`);
  }

  console.log(ui.muted(`Testing ${info.label} (${model})...`));
  const provider = getLLMProvider(providerId, { model });

  try {
    const findings = await provider.review({
      system: "You are a connectivity check for Hubolt. Do not review anything. Return an empty findings array.",
      user: "ping"
    });
    console.log(
      ui.success(`${info.label} OK: credentials valid and structured output works (returned ${findings.length} finding(s)).`)
    );
  } catch (error) {
    process.exitCode = 1;
    console.log(ui.error(`${info.label} failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
