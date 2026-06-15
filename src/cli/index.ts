#!/usr/bin/env node

import { Command } from "commander";
import { handleCliError } from "./errors.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerEvalCommand } from "./commands/eval.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerGatewayCommand } from "./commands/gateway.js";
import { registerGitHubCommand } from "./commands/github.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerPushReportCommand } from "./commands/push-report.js";
import { registerReportCommand } from "./commands/report.js";
import { registerReviewCommand, registerSecurityCommand } from "./commands/review.js";
import { registerServerCommand } from "./commands/server.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerWebhooksCommand } from "./commands/webhooks.js";
import { registerWorkerCommand } from "./commands/worker.js";
import { configureCliHelp, renderHome } from "./help.js";

const program = new Command();

program
  .name("hubolt")
  .description("Context-aware AI code review assistant that is local-first, not local-only.")
  .version("0.1.0");

registerSetupCommand(program);
registerConfigCommand(program);
registerReviewCommand(program);
registerSecurityCommand(program);
registerAnalyzeCommand(program);
registerEvalCommand(program);
registerReportCommand(program);
registerPushReportCommand(program);
registerProvidersCommand(program);
registerCacheCommand(program);
registerLogsCommand(program);
registerServerCommand(program);
registerWebhooksCommand(program);
registerGitHubCommand(program);
registerWorkerCommand(program);
registerHistoryCommand(program);
registerGatewayCommand(program);
registerAuditCommand(program);
registerFeedbackCommand(program);
registerMemoryCommand(program);
configureCliHelp(program);

program.action(() => {
  console.log(renderHome());
});

program.parseAsync(process.argv).catch((error: unknown) => {
  handleCliError(error);
});
