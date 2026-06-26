import { z } from "zod";

/** Bitbucket pull request events that trigger a review. */
export const REVIEWED_BB_EVENTS = new Set(["pullrequest:created", "pullrequest:updated"]);

const BbCommitSchema = z.object({ hash: z.string().min(1) });

const BbEndpointSchema = z.object({
  commit: BbCommitSchema,
  branch: z.object({ name: z.string().min(1) })
});

const BbPullRequestSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().default(""),
  // source is the PR head (the branch being merged in); destination is the base.
  source: BbEndpointSchema,
  destination: BbEndpointSchema
});

const BbRepositorySchema = z.object({
  name: z.string().min(1),
  full_name: z.string().min(1)
});

export const BitbucketPrEventSchema = z.object({
  pullrequest: BbPullRequestSchema,
  repository: BbRepositorySchema
});
export type BitbucketPrEvent = z.infer<typeof BitbucketPrEventSchema>;

export type BbClassification =
  | { kind: "review"; event: BitbucketPrEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; reason: string };

/**
 * Decide what to do with a Bitbucket webhook delivery. Mirrors the GitHub
 * classifier: "review" means a PR event we act on; "ignored" is a well-formed
 * event we deliberately skip; "invalid" claims to be a PR event but does not
 * parse. The event type arrives in the X-Event-Key header (e.g.
 * "pullrequest:created"), not in the body.
 */
export function classifyBitbucketEvent(eventKey: string | undefined, body: unknown): BbClassification {
  if (!eventKey) {
    return { kind: "invalid", reason: "missing X-Event-Key header" };
  }

  if (!REVIEWED_BB_EVENTS.has(eventKey)) {
    return { kind: "ignored", reason: `unsupported event: ${eventKey}` };
  }

  const parsed = BitbucketPrEventSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue?.path.join(".") || "payload";
    return { kind: "invalid", reason: `invalid pull request payload: ${path}: ${issue?.message ?? "unparseable"}` };
  }

  return { kind: "review", event: parsed.data };
}
