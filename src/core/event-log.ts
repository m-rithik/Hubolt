import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReviewEvent } from "../types/events.js";

export interface EventLog {
  append(event: ReviewEvent): void;
}

/**
 * Append-only JSONL event log. One event per line. Callers are responsible for
 * keeping payloads metadata-only; this sink does not redact.
 */
export function createJsonlEventLog(filePath: string): EventLog {
  return {
    append(event: ReviewEvent): void {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(event)}\n`);
    }
  };
}
