import { describe, expect, test } from "vitest";
import { InProcessReviewEventEmitter } from "../../src/core/events.js";
import { createReviewEvent } from "../../src/types/events.js";

describe("review events", () => {
  test("emits typed review events to subscribers", async () => {
    const emitter = new InProcessReviewEventEmitter();
    const received: string[] = [];

    emitter.on("review.started", (event) => {
      received.push(event.type);
    });

    await emitter.emit(
      createReviewEvent({
        type: "review.started",
        repo: "m-rithik/hubolt",
        payload: { phase: 0 },
        redactionState: "metadataOnly"
      })
    );

    expect(received).toEqual(["review.started"]);
  });
});
