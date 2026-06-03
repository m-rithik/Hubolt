import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { getProviderInfo } from "../../providers/llm/catalog.js";
import { runSafely } from "../errors.js";
import { ui } from "../ui.js";

interface ConfigValidateOptions {
  config?: string;
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Inspect and validate Hubolt configuration.");

  config
    .command("validate")
    .description("Validate .hubolt.yml and environment-derived settings.")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ConfigValidateOptions) => {
      runSafely(() => {
        const settings = resolveSettings({ configPath: options.config });
        const rows: Array<[string, string]> = [
          ["Status", ui.success("valid")],
          ["Config source", settings.configPath ?? "built-in defaults"],
          ["Mode", settings.mode],
          ["LLM provider", settings.llmProvider],
          ["LLM model", settings.llmModel]
        ];

        const provider = getProviderInfo(settings.llmProvider);
        if (provider) {
          const present = Boolean(process.env[provider.apiKeyEnv]);
          rows.push([provider.apiKeyEnv, present ? ui.success("set") : ui.error("missing")]);
        }

        console.log(ui.section("Hubolt Config", rows));
      });
    });
}
