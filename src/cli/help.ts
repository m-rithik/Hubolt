import type { Command, Help } from "commander";
import { ui } from "./ui.js";

export function configureCliHelp(program: Command): void {
  configureCommandHelp(program);
}

export function renderHome(): string {
  return [
    ui.title("Hubolt"),
    ui.rule(),
    "Context-aware AI code review assistant. Local-first, not local-only.",
    "",
    ui.title("Core Commands"),
    ui.table([
      ["hubolt setup", "Configure LLM provider (Claude/OpenAI/Google)"],
      ["hubolt review", "Review working-tree changes with AI analysis"],
      ["hubolt review [file]", "Review a specific file"],
      ["hubolt review --staged", "Review staged changes only"],
      ["hubolt security", "Security-focused review (fails on high severity)"],
      ["hubolt analyze", "Run static analyzers only (no LLM)"],
    ]),
    "",
    ui.title("Options for Review Commands"),
    ui.table([
      ["--provider <name>", "Override LLM: anthropic, openai, google"],
      ["--model <model>", "Override model (e.g., gpt-4, claude-opus)"],
      ["--no-llm", "Skip LLM, analyzers only"],
      ["--json <path>", "Write JSON report to file"],
      ["--md <path>", "Write Markdown report to file"],
      ["--ci", "CI mode: deterministic output + exit codes"],
      ["--fail-on <severity>", "Exit 1 if findings >= severity level"],
    ]),
    "",
    ui.title("Server Commands (Team Workflows)"),
    ui.table([
      ["hubolt server", "Start the team review server (requires PostgreSQL)"],
      ["hubolt server bootstrap", "Create first org, user, and API key"],
      ["hubolt push-report", "Push local review to server"],
    ]),
    "",
    ui.title("Utility Commands"),
    ui.table([
      ["hubolt config validate", "Check config and credentials"],
      ["hubolt cache", "Show/clear analysis cache"],
      ["hubolt logs tail", "View recent review events"],
      ["hubolt providers list", "List configured LLM providers"],
    ]),
    "",
    ui.muted("Run hubolt --help for full details or hubolt <command> --help for command-specific help.")
  ].join("\n");
}

function configureCommandHelp(command: Command): void {
  command.configureHelp({
    formatHelp(command: Command, helper: Help): string {
      return renderHelp(command, helper);
    }
  });

  for (const subcommand of command.commands) {
    configureCommandHelp(subcommand);
  }
}

function renderHelp(command: Command, helper: Help): string {
  const sections = [
    ui.title(titleFor(command)),
    ui.rule(),
    helper.commandDescription(command),
    "",
    ui.title("Usage"),
    `  ${helper.commandUsage(command)}`
  ];

  const commands = helper
    .visibleCommands(command)
    .map((subcommand) => [helper.subcommandTerm(subcommand), helper.subcommandDescription(subcommand)] as [string, string]);

  if (commands.length > 0) {
    sections.push("", ui.title("Commands"), ui.table(commands));
  }

  const options = helper
    .visibleOptions(command)
    .map((option) => [helper.optionTerm(option), helper.optionDescription(option)] as [string, string]);

  if (options.length > 0) {
    sections.push("", ui.title("Options"), ui.table(options));
  }

  return `${sections.join("\n")}\n`;
}

function titleFor(command: Command): string {
  const names = [];
  let current: Command | null = command;

  while (current) {
    names.unshift(current.name());
    current = current.parent ?? null;
  }

  return names.map(toTitleCase).join(" ");
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
