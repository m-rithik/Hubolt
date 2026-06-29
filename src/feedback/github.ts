import type { ReviewComment } from "../providers/scm/scm.interface.js";
import { extractFingerprint } from "../github/comments.js";
import type { FeedbackEventInput } from "../memory/feedback-types.js";

/**
 * Turn a pull request's review comments into feedback events. Pure mapping:
 * - a thumbs-up reaction on one of our marked comments = accepted
 * - a thumbs-down = dismissed
 * - a human reply in the thread = discussed
 * External ids make every event idempotent across repeated collection runs.
 */
export function collectPrFeedback(comments: ReviewComment[]): FeedbackEventInput[] {
  const events: FeedbackEventInput[] = [];

  // Our posted findings: comments carrying a fingerprint marker.
  const marked = new Map<number, string>();
  for (const comment of comments) {
    const fingerprint = extractFingerprint(comment.body);
    if (fingerprint) {
      marked.set(comment.id, fingerprint);
    }
  }

  let test = 1;

  for (const comment of comments) {
    const fingerprint = marked.get(comment.id);
    if (fingerprint) {
      if ((comment.reactions?.up ?? 0) > 0) {
        events.push({
          fingerprint,
          verdict: "accepted",
          source: "github-reaction",
          externalId: `gh:rc:${comment.id}:+1`
        });
      }
      if ((comment.reactions?.down ?? 0) > 0) {
        events.push({
          fingerprint,
          verdict: "dismissed",
          source: "github-reaction",
          externalId: `gh:rc:${comment.id}:-1`
        });
      }
      continue;
    }

    // A human reply to one of our marked comments counts as discussion.
    if (comment.inReplyTo && marked.has(comment.inReplyTo) && !comment.authorIsBot) {
      events.push({
        fingerprint: marked.get(comment.inReplyTo)!,
        verdict: "discussed",
        source: "github-reply",
        externalId: `gh:rc:${comment.inReplyTo}:reply:${comment.id}`,
        actor: comment.authorLogin,
        role: comment.authorRole
      });
    }
  }

  return events;
}
