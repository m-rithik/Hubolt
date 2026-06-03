#!/usr/bin/env node

import { Command } from "commander";
import { handleCliError } from "./errors.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSetupCommand } from "./commands/setup.js";
import { configureCliHelp, renderHome } from "./help.js";

const program = new Command();

program
  .name("hubolt")
  .description("Context-aware AI code review assistant that is local-first, not local-only.")
  .version("0.1.0");

registerSetupCommand(program);
registerConfigCommand(program);
registerReviewCommand(program);
configureCliHelp(program);

program.action(() => {
  console.log(renderHome());
});

program.parseAsync(process.argv).catch((error: unknown) => {
  handleCliError(error);
});
