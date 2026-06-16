import { describe, expect, test } from "vitest";
import { collectPrFeedback } from "../../src/feedback/github.js";
import { findingMarker } from "../../src/github/comments.js";
import type { ReviewComment } from "../../src/providers/scm/scm.interface.js";

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: 1,
    body: "",
    path: "src/a.ts",
    line: 10,
    inReplyTo: null,
    authorLogin: "human",
    authorIsBot: false,
    reactions: { up: 0, down: 0 },
    ...overrides
  };
}

describe("collectPrFeedback", () => {
  const marked = comment({
    id: 100,
    body: `**Finding**\n${findingMarker("fp-abc")}`,
    authorIsBot: true,
    reactions: { up: 2, down: 1 }
  });

  test("maps reactions on marked comments to accepted and dismissed", () => {
    const events = collectPrFeedback([marked]);
    expect(events).toEqual([
      { fingerprint: "fp-abc", verdict: "accepted", source: "github-reaction", externalId: "gh:rc:100:+1" },
      { fingerprint: "fp-abc", verdict: "dismissed", source: "github-reaction", externalId: "gh:rc:100:-1" }
    ]);
  });

  test("maps human replies to discussed and ignores bot replies", () => {
    const humanReply = comment({ id: 101, inReplyTo: 100, body: "is this real?", authorLogin: "alice" });
    const botReply = comment({ id: 102, inReplyTo: 100, authorIsBot: true });

    const events = collectPrFeedback([
      comment({ id: 100, body: findingMarker("fp-abc"), authorIsBot: true }),
      humanReply,
      botReply
    ]);

    expect(events).toEqual([
      {
        fingerprint: "fp-abc",
        verdict: "discussed",
        source: "github-reply",
        externalId: "gh:rc:100:reply:101",
        actor: "alice"
      }
    ]);
  });

  test("carries the replier's repo role through to the event", () => {
    const events = collectPrFeedback([
      comment({ id: 100, body: findingMarker("fp-abc"), authorIsBot: true }),
      comment({ id: 101, inReplyTo: 100, body: "good catch", authorLogin: "maint", authorRole: "MEMBER" })
    ]);

    expect(events[0]).toMatchObject({ verdict: "discussed", actor: "maint", role: "MEMBER" });
  });

  test("ignores unmarked comments and replies to them", () => {
    const events = collectPrFeedback([
      comment({ id: 200, body: "just a human comment", reactions: { up: 5, down: 0 } }),
      comment({ id: 201, inReplyTo: 200, body: "reply" })
    ]);
    expect(events).toEqual([]);
  });
});
