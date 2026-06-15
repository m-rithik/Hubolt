import type { Command } from "commander";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import {
  resolveServerConnection,
  serverGet,
  serverPost,
  type ServerConnectionOptions
} from "../server-client.js";
import { retrieveCards } from "../../memory/retrieval.js";
import type { MemoryCardData } from "../../memory/cards.js";

interface MemoryOptions extends ServerConnectionOptions {
  repo?: string;
  rules?: string;
  title?: string;
  body?: string;
}

type CardRow = MemoryCardData & { id: string };

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Inspect and rebuild team memory cards.");

  memory
    .command("list")
    .description("Show stored memory cards with scopes and token estimates.")
    .option("--repo <repoId>", "include cards scoped to this repository id")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: MemoryOptions) => runSafelyAsync(() => listCards(options)));

  memory
    .command("inspect")
    .description("Show which cards a review would retrieve, and why.")
    .option("--repo <repoId>", "repository id the hypothetical review runs in")
    .option("--rules <ids>", "comma-separated rule ids present in the review")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: MemoryOptions) => runSafelyAsync(() => inspectCards(options)));

  memory
    .command("add")
    .description("Add or update a maintainer-authored style card (pinned; survives rebuilds).")
    .requiredOption("--title <title>", "card title; also its stable slot key")
    .requiredOption("--body <text>", "card content, kept compact for prompts")
    .option("--repo <repoId>", "scope to one repository (default: organization-wide)")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: MemoryOptions) => runSafelyAsync(() => addStyleCard(options)));

  memory
    .command("rebuild")
    .description("Regenerate rule-calibration cards from stored feedback.")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: MemoryOptions) => runSafelyAsync(() => rebuild(options)));
}

async function fetchCards(options: MemoryOptions): Promise<CardRow[]> {
  const connection = resolveServerConnection(options);
  const query = options.repo ? `?repo=${encodeURIComponent(options.repo)}` : "";
  const result = await serverGet<{ cards: CardRow[] }>(connection, `/memory/cards${query}`);
  return result.cards;
}

async function listCards(options: MemoryOptions): Promise<void> {
  const cards = await fetchCards(options);

  if (cards.length === 0) {
    console.log("No memory cards stored. Run hubolt memory rebuild after importing feedback.");
    return;
  }

  console.log(ui.title(`Memory cards (${cards.length})`));
  console.log(ui.grid(
    ["Kind", "Scope", "Rule", "Tokens", "Sources", "Title"],
    cards.map((card) => [
      card.kind + (card.pinned ? " (pinned)" : ""),
      card.repoId || "org",
      card.ruleId || "-",
      String(card.tokensEstimate),
      String(card.sourceCount),
      card.title
    ])
  ));
}

async function inspectCards(options: MemoryOptions): Promise<void> {
  const cards = await fetchCards(options);
  const ruleIds = (options.rules ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const retrieved = retrieveCards(cards, {
    repoId: options.repo,
    ruleIds,
    budgetTokens: 1200
  });

  console.log(ui.title("Memory retrieval"));
  console.log(ui.table([
    ["Cards stored", String(cards.length)],
    ["Rules in review", ruleIds.length > 0 ? ruleIds.join(", ") : "(none given)"],
    ["Token budget", "1200"],
    ["Retrieved", String(retrieved.length)]
  ]));

  if (retrieved.length === 0) {
    console.log("");
    console.log("No cards would be injected for this review.");
    return;
  }

  for (const entry of retrieved) {
    console.log("");
    console.log(ui.success(`${entry.card.title}  (${entry.card.tokensEstimate} tokens)`));
    console.log(ui.muted(`  selected because: ${entry.reason}`));
    console.log(`  ${entry.card.body}`);
  }
}

async function addStyleCard(options: MemoryOptions): Promise<void> {
  const connection = resolveServerConnection(options);
  const result = await serverPost<{ card: CardRow }>(connection, "/memory/cards", {
    title: options.title,
    body: options.body,
    ...(options.repo ? { repoId: options.repo } : {})
  });

  console.log(ui.success("Style card saved"));
  console.log(ui.table([
    ["Title", result.card.title],
    ["Scope", result.card.repoId || "org"],
    ["Tokens", String(result.card.tokensEstimate)]
  ]));
}

async function rebuild(options: MemoryOptions): Promise<void> {
  const connection = resolveServerConnection(options);
  const result = await serverPost<{ ruleCards: number; removedStale: number; styleCardsKept: number }>(
    connection,
    "/memory/rebuild",
    {}
  );

  console.log(ui.success("Memory rebuilt"));
  console.log(ui.table([
    ["Rule cards", String(result.ruleCards)],
    ["Stale cards removed", String(result.removedStale)],
    ["Style cards kept", String(result.styleCardsKept)]
  ]));
}
