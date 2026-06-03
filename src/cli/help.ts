import type { Command, Help } from "commander";
import { ui } from "./ui.js";

export function configureCliHelp(program: Command): void {
  configureCommandHelp(program);
}

export function renderHome(): string {
  return [
    ui.title("Hubolt"),
    ui.rule(),
    "Context-aware AI code review assistant.",
    "",
    ui.title("Commands"),
    ui.table([
      ["hubolt setup", "interactive setup; saves provider/model/key to .env"],
      ["hubolt setup --print", "print a starter .hubolt.yml"],
      ["hubolt config validate", "validate config, defaults, and credentials"],
      ["hubolt review", "resolve the review scope for working-tree changes"],
      ["hubolt review --staged", "resolve the review scope for staged changes"]
    ]),
    "",
    ui.muted("Run hubolt --help for the full command list. The analysis engine is not implemented yet.")
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
