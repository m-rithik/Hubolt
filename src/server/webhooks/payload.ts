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
  repository: WebhookRepositorySchema,
  // Present when delivered by a GitHub App installation; used to mint the
  // installation token that lets the worker post the review.
  installation: z.object({ id: z.number().int().positive() }).optional()
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

const InstallationRepoSchema = z.object({ full_name: z.string().min(1) });

const InstallationEventSchema = z.object({
  action: z.string().min(1),
  installation: z.object({
    id: z.number().int().positive(),
    account: z.object({ login: z.string().min(1) }).optional()
  }),
  repositories: z.array(InstallationRepoSchema).optional(),
  repositories_added: z.array(InstallationRepoSchema).optional(),
  repositories_removed: z.array(InstallationRepoSchema).optional()
});

export interface InstallationChange {
  installationId: string;
  /** GitHub account that owns this installation, when supplied by GitHub. */
  accountLogin?: string;
  /** Repos (full names) this installation now covers. */
  linked: string[];
  /** Repos no longer covered (uninstalled, suspended, or removed). */
  unlinked: string[];
}

const INSTALLATION_REMOVED_ACTIONS = new Set(["deleted", "suspend"]);

/**
 * Normalize an `installation` or `installation_repositories` webhook into the
 * set of repos to mark installed or no longer installed. Returns null for any
 * other event so the caller can fall through to pull-request handling.
 */
export function classifyInstallationEvent(eventName: string | undefined, body: unknown): InstallationChange | null {
  if (eventName !== "installation" && eventName !== "installation_repositories") {
    return null;
  }

  const parsed = InstallationEventSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const event = parsed.data;
  const installationId = String(event.installation.id);
  const accountLogin = event.installation.account?.login;
  const names = (repos: typeof event.repositories): string[] => (repos ?? []).map((repo) => repo.full_name);

  if (eventName === "installation") {
    if (INSTALLATION_REMOVED_ACTIONS.has(event.action)) {
      return { installationId, accountLogin, linked: [], unlinked: names(event.repositories) };
    }
    return { installationId, accountLogin, linked: names(event.repositories), unlinked: [] };
  }

  return {
    installationId,
    accountLogin,
    linked: names(event.repositories_added),
    unlinked: names(event.repositories_removed)
  };
}
