import type { Command } from "commander";
import { defaultEventLogPath, readEventLog } from "../../core/event-log.js";
import type { ReviewEvent } from "../../types/events.js";
import { runSafely } from "../errors.js";
import { ui } from "../ui.js";

export function registerLogsCommand(program: Command): void {
  const logs = program.command("logs").description("Inspect the local review event log.");

  logs
    .command("tail")
    .description("Show the most recent events from .hubolt/logs/events.jsonl.")
    .option("-n, --count <number>", "number of events to show", "20")
    .action((options: { count: string }) => {
      runSafely(() => tail(parseCount(options.count)));
    });

  logs
    .command("inspect")
    .description("Summarize the local review event log.")
    .action(() => {
      runSafely(() => inspect());
    });
}

function tail(count: number): void {
  const events = readEventLog(defaultEventLogPath());
  if (events.length === 0) {
    console.log(ui.muted("No events logged yet. Run hubolt review first."));
    return;
  }

  const recent = events.slice(-count);
  const rows = recent.map((event) => [
    formatTime(event.createdAt),
    event.type,
    event.redactionState,
    summarizePayload(event)
  ]);

  console.log(ui.grid(["Time", "Event", "Redaction", "Detail"], rows));
  console.log("");
  console.log(ui.muted(`Showing ${recent.length} of ${events.length} event(s).`));
}

function inspect(): void {
  const events = readEventLog(defaultEventLogPath());
  if (events.length === 0) {
    console.log(ui.muted("No events logged yet. Run hubolt review first."));
    return;
  }

  const reviews = events.filter((event) => event.type === "review.started").length;
  console.log(
    ui.section("Hubolt Log", [
      ["Path", defaultEventLogPath()],
      ["Events", String(events.length)],
      ["Reviews", String(reviews)],
      ["First", formatTime(events[0].createdAt)],
      ["Last", formatTime(events[events.length - 1].createdAt)]
    ])
  );

  console.log("");
  console.log(ui.grid(["Event type", "Count"], countBy(events, (event) => event.type)));

  const redaction = countBy(events, (event) => event.redactionState);
  console.log("");
  console.log(ui.grid(["Redaction", "Count"], redaction));

  const severities = countBy(
    events.filter((event) => event.type === "finding.created"),
    (event) => severityOf(event)
  );
  if (severities.length > 0) {
    console.log("");
    console.log(ui.grid(["Finding severity", "Count"], severities));
  }
}

function countBy(events: ReviewEvent[], key: (event: ReviewEvent) => string): string[][] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = key(event);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => [value, String(count)]);
}

function severityOf(event: ReviewEvent): string {
  const payload = event.payload as { severity?: string } | undefined;
  return payload?.severity ?? "unknown";
}

function summarizePayload(event: ReviewEvent): string {
  if (event.payload === undefined || event.payload === null) {
    return "";
  }
  const text = JSON.stringify(event.payload);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function parseCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
}
