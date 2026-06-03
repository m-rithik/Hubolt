import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewEvent } from "../types/events.js";

export interface EventLog {
  append(event: ReviewEvent): void;
}

export function defaultEventLogPath(cwd: string = process.cwd()): string {
  return join(cwd, ".hubolt", "logs", "events.jsonl");
}

/** Parse JSONL log content into events, skipping blank or malformed lines. */
export function parseEventLog(content: string): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as ReviewEvent);
    } catch {
      // skip a partially written or corrupt line
    }
  }
  return events;
}

export function readEventLog(filePath: string): ReviewEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return parseEventLog(readFileSync(filePath, "utf8"));
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
