import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
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

        if (settings.llmProvider === "openai") {
          const present = Boolean(process.env.OPENAI_API_KEY);
          rows.push(["OPENAI_API_KEY", present ? ui.success("set") : ui.error("missing")]);
        }

        console.log(ui.section("Hubolt Config", rows));
      });
    });
}
