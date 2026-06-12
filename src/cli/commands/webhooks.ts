import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { loadServerEnv } from "../../config/env.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import { computeGitHubSignature, verifyGitHubSignature } from "../../server/webhooks/signature.js";
import { classifyWebhookEvent } from "../../server/webhooks/payload.js";
import { reviewJobId } from "../../queue/review-jobs.js";

interface VerifyFixtureOptions {
  event?: string;
  signature?: string;
  secret?: string;
}

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program
    .command("webhooks")
    .description("Validate GitHub webhook handling against local fixtures.");

  webhooks
    .command("verify-fixture <path>")
    .description("Verify signature and payload handling for a raw webhook body fixture.")
    .option("--event <name>", "value of the X-GitHub-Event header (default: pull_request)")
    .option("--signature <value>", "X-Hub-Signature-256 header value to verify against the fixture bytes")
    .option("--secret <value>", "webhook secret (default: GITHUB_WEBHOOK_SECRET env)")
    .action((path: string, options: VerifyFixtureOptions) => {
      return runSafelyAsync(() => verifyFixture(path, options));
    });
}

async function verifyFixture(path: string, options: VerifyFixtureOptions): Promise<void> {
  loadServerEnv();

  const rawBody = await readFile(path);
  const eventName = options.event || "pull_request";
  const secret = options.secret || process.env.GITHUB_WEBHOOK_SECRET;

  console.log(ui.title("Webhook fixture verification"));
  console.log(`Fixture: ${path} (${rawBody.length} bytes)`);
  console.log(`Event: ${eventName}`);

  const failures: string[] = [];

  if (!secret) {
    failures.push("No webhook secret available; pass --secret or set GITHUB_WEBHOOK_SECRET");
  } else if (options.signature) {
    if (verifyGitHubSignature(secret, rawBody, options.signature)) {
      console.log(ui.success("Signature: valid"));
    } else {
      failures.push("Signature: does not match fixture bytes");
    }
  } else {
    console.log("Signature: none provided; expected header value for this fixture:");
    console.log(`  ${computeGitHubSignature(secret, rawBody)}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    failures.push("Payload: fixture is not valid JSON");
    reportAndExit(failures);
    return;
  }

  const classification = classifyWebhookEvent(eventName, body);

  if (classification.kind === "invalid") {
    failures.push(`Payload: ${classification.reason}`);
  } else if (classification.kind === "ignored") {
    console.log(`Payload: well-formed, would be ignored (${classification.reason})`);
  } else {
    const event = classification.event;
    console.log(ui.success("Payload: well-formed, would enqueue a review job"));
    console.log(`  repository: ${event.repository.full_name}`);
    console.log(`  pull request: #${event.pull_request.number} (${event.action})`);
    console.log(`  head: ${event.pull_request.head.sha}`);
    console.log(`  base: ${event.pull_request.base.ref} @ ${event.pull_request.base.sha}`);
    console.log(
      `  job id (given repo id <repoId>): ${reviewJobId({
        repoId: "<repoId>",
        prNumber: event.pull_request.number,
        headSha: event.pull_request.head.sha
      })}`
    );
  }

  reportAndExit(failures);
}

function reportAndExit(failures: string[]): void {
  if (failures.length === 0) {
    console.log(ui.success("Fixture verification passed"));
    return;
  }

  for (const failure of failures) {
    console.error(ui.error(failure));
  }
  throw new Error(`Fixture verification failed with ${failures.length} problem(s)`);
}
