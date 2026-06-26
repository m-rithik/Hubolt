import { describe, expect, test } from "vitest";
import { classifyBitbucketEvent } from "../../src/server/webhooks/bitbucket-payload.js";

const validBody = {
  pullrequest: {
    id: 7,
    title: "Add feature",
    source: { commit: { hash: "aaa111" }, branch: { name: "feature" } },
    destination: { commit: { hash: "bbb222" }, branch: { name: "main" } }
  },
  repository: { name: "repo", full_name: "workspace/repo" }
};

describe("classifyBitbucketEvent", () => {
  test("classifies a created pull request as review", () => {
    const result = classifyBitbucketEvent("pullrequest:created", validBody);
    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.event.pullrequest.id).toBe(7);
      expect(result.event.repository.full_name).toBe("workspace/repo");
    }
  });

  test("ignores unsupported event keys", () => {
    expect(classifyBitbucketEvent("repo:push", validBody).kind).toBe("ignored");
  });

  test("rejects a missing event key", () => {
    expect(classifyBitbucketEvent(undefined, validBody).kind).toBe("invalid");
  });

  test("rejects a malformed payload", () => {
    expect(classifyBitbucketEvent("pullrequest:created", { pullrequest: {} }).kind).toBe("invalid");
  });
});
