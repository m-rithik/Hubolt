import { api } from "../api.js";
import { el, table, emptyState, timeCell, setHash, debounce } from "../dom.js";

const PAGE_SIZE = 50;

function auditHash({ action, offset }) {
  const query = new URLSearchParams();
  if (action) query.set("action", action);
  if (offset > 0) query.set("offset", String(offset));
  const suffix = query.toString();
  return suffix ? `#/audit?${suffix}` : "#/audit";
}

export async function renderAudit(container, state = {}) {
  const offset = Number.parseInt(state.offset, 10) || 0;
  const action = state.action || "";

  const result = await api.auditEvents({ limit: PAGE_SIZE, offset, action: action || undefined });

  const filterInput = el("input", {
    type: "search",
    placeholder: "Filter by action (e.g. budget)",
    value: action
  });
  filterInput.addEventListener(
    "input",
    debounce(() => {
      setHash(auditHash({ action: filterInput.value.trim(), offset: 0 }), { replace: true });
    }, 300)
  );

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
      setHash(auditHash({ action, offset: Math.max(0, offset - PAGE_SIZE) }))
    );
    next.addEventListener("click", () => setHash(auditHash({ action, offset: offset + PAGE_SIZE })));

    card.append(el("div", { class: "pager" }, [`${from}-${to} of ${total}`, prev, next]));
  }

  container.replaceChildren(...parts);

  if (action && document.activeElement === document.body) {
    const end = filterInput.value.length;
    filterInput.focus();
    filterInput.setSelectionRange(end, end);
  }
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
