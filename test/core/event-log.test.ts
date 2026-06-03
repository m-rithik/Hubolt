import { describe, expect, test } from "vitest";
import { parseEventLog } from "../../src/core/event-log.js";
import { createReviewEvent } from "../../src/types/events.js";

describe("parseEventLog", () => {
  test("parses one event per JSONL line", () => {
    const a = createReviewEvent({ type: "review.started", repo: "r", payload: { scope: "x" }, redactionState: "metadataOnly" });
    const b = createReviewEvent({ type: "review.completed", repo: "r", payload: { findings: 2 }, redactionState: "metadataOnly" });
    const content = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`;

    const events = parseEventLog(content);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("review.started");
    expect(events[1].type).toBe("review.completed");
  });

  test("skips blank and malformed lines", () => {
    const valid = createReviewEvent({ type: "finding.created", repo: "r", payload: { severity: "high" }, redactionState: "metadataOnly" });
    const content = ["", "{not json", JSON.stringify(valid), "   "].join("\n");

    const events = parseEventLog(content);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("finding.created");
  });

  test("returns empty for empty content", () => {
    expect(parseEventLog("")).toEqual([]);
  });
});
