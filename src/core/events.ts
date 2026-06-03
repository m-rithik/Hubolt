import type { ReviewEvent } from "../types/events.js";

export type ReviewEventHandler = (event: ReviewEvent) => void | Promise<void>;

export class InProcessReviewEventEmitter {
  private readonly handlers = new Map<string, ReviewEventHandler[]>();

  on(type: ReviewEvent["type"] | "*", handler: ReviewEventHandler): void {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  async emit(event: ReviewEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    const wildcardHandlers = this.handlers.get("*") ?? [];

    for (const handler of [...handlers, ...wildcardHandlers]) {
      await handler(event);
    }
  }
}
