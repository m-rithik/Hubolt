import { api } from "../api.js";
import { el, table, emptyState, timeCell } from "../dom.js";

const PAGE_SIZE = 50;

export async function renderAudit(container, state = {}) {
  const offset = state.offset || 0;
  const action = state.action || "";

  const result = await api.auditEvents({ limit: PAGE_SIZE, offset, action: action || undefined });

  const filterInput = el("input", {
    type: "search",
    placeholder: "Filter by action (e.g. budget)",
    value: action
  });
  filterInput.addEventListener("change", () => {
    renderAudit(container, { offset: 0, action: filterInput.value.trim() });
  });

  const card = el("div", { class: "section" });
  const parts = [el("div", { class: "toolbar" }, [filterInput]), card];

  if (result.events.length === 0) {
    card.append(emptyState(action ? "No audit events match this filter." : "No audit events recorded."));
  } else {
    card.append(
      table(
        ["Time", "Action", "Resource", "Details"],
        result.events.map((event) =>
          el("tr", {}, [
            timeCell(event.createdAt),
            el("td", { class: "mono", text: event.action }),
            el("td", { class: "dim", text: event.resourceId ? `${event.resource} (${event.resourceId})` : event.resource }),
            el("td", { class: "dim", text: summarizeDetails(event.details) })
          ])
        )
      )
    );

    const { total } = result.pagination;
    const from = offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    const prev = el("button", { text: "Previous" });
    const next = el("button", { text: "Next" });
    prev.disabled = offset === 0;
    next.disabled = to >= total;
    prev.addEventListener("click", () =>
      renderAudit(container, { offset: Math.max(0, offset - PAGE_SIZE), action })
    );
    next.addEventListener("click", () => renderAudit(container, { offset: offset + PAGE_SIZE, action }));

    card.append(el("div", { class: "pager" }, [`${from}-${to} of ${total}`, prev, next]));
  }

  container.replaceChildren(...parts);
}

/** Render stored JSON details as compact key: value text, defensively. */
function summarizeDetails(details) {
  if (!details) return "-";
  try {
    const parsed = JSON.parse(details);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join(", ");
    }
    return String(parsed);
  } catch {
    return details.slice(0, 120);
  }
}
