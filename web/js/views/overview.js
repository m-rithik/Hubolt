import { api } from "../api.js";
import { el, table, section, statStrip, emptyState, emptyWithCommand, timeCell, notice, formatCount, formatUsd, formatUptime } from "../dom.js";

export async function renderOverview(container) {
  const [health, reviewsResult, budgetsResult, gatewayResult] = await Promise.allSettled([
    api.health(),
    api.reviews({ limit: 8 }),
    api.budgets(),
    api.gatewayStatus()
  ]);

  const blocks = [];
  const stats = [];

  if (health.status === "fulfilled") {
    stats.push(
      { value: health.value.database.connected ? "Online" : "Down", label: "Database" },
      { value: formatUptime(health.value.uptime), label: "Uptime" }
    );
  } else {
    blocks.push(notice("error", "Health check failed: " + health.reason.message));
  }

  if (reviewsResult.status === "fulfilled") {
    stats.push({ value: formatCount(reviewsResult.value.pagination.total), label: "Reviews stored" });
  }

  if (budgetsResult.status === "fulfilled") {
    const spend = budgetsResult.value.budgets.reduce((sum, b) => sum + b.currentMonthCostUsd, 0);
    stats.push({ value: formatUsd(spend), label: "Spend this month" });
  }

  if (gatewayResult.status === "fulfilled") {
    const queue = gatewayResult.value.status.queueStatus;
    stats.push(
      { value: formatCount(queue.waiting ?? 0), label: "Queue waiting" },
      { value: formatCount(queue.failed ?? 0), label: "Queue failed" }
    );
  }

  if (stats.length > 0) {
    blocks.push(section("Status", null, statStrip(stats)));
  }

  const recentBody =
    reviewsResult.status === "fulfilled" && reviewsResult.value.reviews.length > 0
      ? table(
          ["Repository", "Provider", "Model", { label: "Findings", numeric: true }, "Created"],
          reviewsResult.value.reviews.map((review) =>
            el("tr", { class: "clickable", onclick: () => { window.location.hash = `#/reviews/${review.id}`; } }, [
              el("td", {}, el("a", { class: "cell-link", href: `#/reviews/${review.id}`, text: review.repository })),
              el("td", { class: "dim", text: review.provider }),
              el("td", { class: "mono dim", text: review.model }),
              el("td", { class: "num", text: String(review.findingCount) }),
              timeCell(review.createdAt)
            ])
          )
        )
      : emptyWithCommand(
          "no reviews ingested yet - push one from any repo:",
          "hubolt review --staged --json review.json && hubolt push-report --report review.json"
        );

  blocks.push(section("Recent reviews", null, recentBody));

  container.replaceChildren(...blocks);
}
