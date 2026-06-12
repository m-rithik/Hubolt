import { z } from "zod";

/** Pull request actions that trigger a review. */
export const REVIEWED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

const GitRefSchema = z.object({
  sha: z.string().min(1),
  ref: z.string().min(1)
});

const WebhookRepositorySchema = z.object({
  name: z.string().min(1),
  full_name: z.string().min(1),
  html_url: z.string().url()
});

const WebhookPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  draft: z.boolean().default(false),
  head: GitRefSchema,
  base: GitRefSchema
});

export const PullRequestEventSchema = z.object({
  action: z.string().min(1),
  pull_request: WebhookPullRequestSchema,
  repository: WebhookRepositorySchema
});
export type PullRequestEvent = z.infer<typeof PullRequestEventSchema>;

export type WebhookClassification =
  | { kind: "review"; event: PullRequestEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; reason: string };

/**
 * Decide what to do with a delivered webhook. "review" means enqueue a review
 * job; "ignored" is a well-formed event we deliberately skip (always
 * acknowledged with 2xx so GitHub does not retry); "invalid" is a payload
 * that claims to be a pull_request event but does not parse.
 */
export function classifyWebhookEvent(eventName: string | undefined, body: unknown): WebhookClassification {
  if (!eventName) {
    return { kind: "invalid", reason: "missing X-GitHub-Event header" };
  }

  if (eventName === "ping") {
    return { kind: "ignored", reason: "ping event" };
  }

  if (eventName !== "pull_request") {
    return { kind: "ignored", reason: `unsupported event: ${eventName}` };
  }

  const parsed = PullRequestEventSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue?.path.join(".") || "payload";
    return { kind: "invalid", reason: `invalid pull_request payload: ${path}: ${issue?.message ?? "unparseable"}` };
  }

  const event = parsed.data;

  if (!REVIEWED_PR_ACTIONS.has(event.action)) {
    return { kind: "ignored", reason: `action does not trigger review: ${event.action}` };
  }

  if (event.pull_request.draft) {
    return { kind: "ignored", reason: "draft pull request" };
  }

  return { kind: "review", event };
}
