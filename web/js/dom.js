/**
 * DOM helpers. All values are set through textContent or attributes, never
 * via HTML strings, so API data cannot inject markup.
 */

import { countUp } from "./fx.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (name === "class") {
      node.className = value;
    } else if (name === "text") {
      node.textContent = value;
    } else if (name.startsWith("on") && typeof value === "function") {
      node.addEventListener(name.slice(2), value);
    } else {
      node.setAttribute(name, value);
    }
  }

  for (const child of [].concat(children)) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function table(headers, rows) {
  return el("table", {}, [
    el("thead", {}, el("tr", {}, headers.map((h) =>
      el("th", { class: h.numeric ? "num" : undefined, text: h.label ?? h })
    ))),
    el("tbody", {}, rows)
  ]);
}

export function severityBadge(severity) {
  const known = ["critical", "high", "medium", "low", "info"];
  const value = known.includes(severity) ? severity : "info";
  return el("span", { class: `severity ${value}`, text: value });
}

export function notice(kind, message) {
  return el("div", { class: `notice ${kind}`, text: message });
}

export function emptyState(message) {
  return el("div", { class: "empty", text: message });
}

/**
 * Flat page section: heading row, optional muted description, body content.
 * Sections separate with hairline dividers via CSS rather than card boxes.
 */
export function section(title, description, children) {
  const head = el("div", { class: "section-head" }, [
    el("h2", { class: "section-title", text: title })
  ]);
  const body = el("div", { class: "section-body" }, children);

  return el("div", { class: "section" }, [
    head,
    description ? el("p", { class: "section-desc", text: description }) : null,
    body
  ]);
}

/** One row of figures separated by hairlines. items: [{ value, label }]. */
export function statStrip(items) {
  return el("div", { class: "stats" },
    items.map((item) => {
      const value = el("div", { class: "stat-value" });
      countUp(value, item.value);
      return el("div", { class: "stat" }, [
        value,
        el("div", { class: "stat-label", text: item.label })
      ]);
    })
  );
}

/** Inline usage bar with percentage figure. */
export function usageBar(percent, warnAt) {
  const clamped = Math.max(0, Math.min(percent, 100));
  const state = percent >= 100 ? "over" : percent >= warnAt ? "warn" : "";
  return el("div", { class: "usage" }, [
    el("div", { class: "usage-track" },
      el("div", { class: `usage-fill ${state}`, style: `width:${clamped}%` })
    ),
    el("span", { class: "usage-pct", text: `${percent.toFixed(0)}%` })
  ]);
}

/**
 * Compact relative time for table scanning ("3h ago"); the exact timestamp
 * goes in the title attribute. Falls back to the absolute date past a week.
 */
export function formatRelative(iso) {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(iso);
}

/** Table cell with relative time shown and the exact timestamp on hover. */
export function timeCell(iso, className = "dim") {
  return el("td", { class: className, title: iso ? new Date(iso).toLocaleString() : undefined, text: formatRelative(iso) });
}

/** Actionable empty state: a comment line plus a runnable command. */
export function emptyWithCommand(message, command) {
  return el("div", {}, [
    el("div", { class: "empty", text: message }),
    el("div", { class: "cmd-hint" }, [
      el("span", { class: "cmd-prompt", text: "$ " }),
      command
    ])
  ]);
}

export function formatDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString();
}

export function formatUptime(seconds) {
  if (typeof seconds !== "number") return "-";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
