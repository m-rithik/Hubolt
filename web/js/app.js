import { api, clearKey, getStoredKey } from "./api.js";
import { el, clear, notice } from "./dom.js";
import { renderConnect } from "./views/connect.js";
import { renderOverview } from "./views/overview.js";
import { renderReviews, renderReviewDetail } from "./views/reviews.js";
import { renderBudgets } from "./views/budgets.js";
import { renderGateway } from "./views/gateway.js";
import { renderGitHubRepos } from "./views/github-repos.js";
import { renderAudit } from "./views/audit.js";
import { renderOrganization } from "./views/organization.js";

const ROUTES = [
  { path: "overview", title: "Overview", description: "Health, queue pressure, recent reviews, and monthly spend.", render: renderOverview },
  { path: "reviews", title: "Reviews", description: "Review history with findings, analyzer signals, and model usage.", render: renderReviews },
  { path: "budgets", title: "Budgets", description: "Provider-level monthly limits and alert thresholds.", render: renderBudgets },
  { path: "gateway", title: "Gateway", description: "LLM credentials, queue state, and routeable model catalog.", render: renderGateway },
  { path: "repos", title: "GitHub Repos", description: "Registered repositories reviewed automatically on every pull request.", render: renderGitHubRepos },
  { path: "audit", title: "Audit log", description: "Organization actions recorded for operational traceability.", render: renderAudit },
  { path: "organization", title: "Organization", description: "Members, API key metadata, and account identity.", render: renderOrganization }
];

const KEYMAP = [
  ["1-7", "switch view"],
  ["j / k", "move row selection"],
  ["enter", "open selected row"],
  ["/", "focus the filter"],
  ["r", "reload current view"],
  ["?", "toggle this keymap"],
  ["esc", "close / clear selection"]
];

const app = document.getElementById("app");
const sidebar = document.getElementById("sidebar");
const nav = document.getElementById("nav");
const sidebarFoot = document.getElementById("sidebar-foot");
const topbar = document.getElementById("topbar");
const pageTitle = document.getElementById("page-title");
const pageDesc = document.getElementById("page-desc");
const topbarStatus = document.getElementById("topbar-status");
const view = document.getElementById("view");

let healthTimer = null;
let selectedRow = -1;
// Remembers the last reviews list (filter + page) so detail pages return to
// where the user actually was, surviving refresh and deep links.
let lastReviewsHash = "#/reviews";

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const [path, ...rest] = pathPart.split("/");
  const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
  return { path: path || "overview", arg: rest.join("/") || null, query };
}

function buildNav() {
  clear(nav);
  ROUTES.forEach((route, index) => {
    nav.append(
      el("a", { href: `#/${route.path}`, "data-path": route.path }, [
        el("span", { text: route.title.toLowerCase() }),
        el("span", { class: "nav-key", text: String(index + 1) })
      ])
    );
  });
}

function setActiveNav(path) {
  for (const link of nav.querySelectorAll("a")) {
    link.classList.toggle("active", link.getAttribute("data-path") === path);
  }
}

async function buildSidebarFoot() {
  clear(sidebarFoot);
  const keysHint = el("button", { class: "foot-link", text: "? keymap" });
  keysHint.addEventListener("click", toggleKeymap);
  const disconnect = el("button", { class: "foot-link", text: "disconnect" });
  disconnect.addEventListener("click", () => {
    clearKey();
    boot();
  });

  try {
    const org = await api.org();
    sidebarFoot.append(
      el("span", { class: "org-name", text: org.name }),
      el("span", { class: "org-slug", text: org.slug }),
      el("div", { class: "foot-actions" }, [keysHint, disconnect])
    );
  } catch {
    sidebarFoot.append(el("div", { class: "foot-actions" }, [keysHint, disconnect]));
  }
}

async function pollHealth() {
  try {
    const health = await api.health();
    const ok = health.database.connected;
    topbarStatus.replaceChildren(
      el("span", { class: `status-dot ${ok ? "ok" : "bad"}` }),
      el("span", { text: ok ? `db ok . ${health.database.latencyMs}ms` : "db unreachable" })
    );
  } catch {
    topbarStatus.replaceChildren(
      el("span", { class: "status-dot bad" }),
      el("span", { text: "server unreachable" })
    );
  }
}

async function route() {
  const { path, arg, query } = parseHash();
  selectedRow = -1;

  if (path === "reviews" && arg) {
    pageTitle.textContent = "review detail";
    pageDesc.textContent = "Findings, analyzer signals, and model usage for one review.";
    document.title = "review detail - hubolt";
    setActiveNav("reviews");
    await safeRender((container) => renderReviewDetail(container, arg, lastReviewsHash));
    return;
  }

  if (path === "reviews") {
    lastReviewsHash = window.location.hash || "#/reviews";
  }

  const match = ROUTES.find((route) => route.path === path) ?? ROUTES[0];
  pageTitle.textContent = match.title.toLowerCase();
  pageDesc.textContent = match.description;
  document.title = `${match.title.toLowerCase()} - hubolt`;
  setActiveNav(match.path);
  await safeRender((container) => match.render(container, query));
}

async function safeRender(render) {
  clear(view);

  // Defer the loading line so fast responses never flash it.
  const loadingTimer = setTimeout(() => {
    if (!view.firstChild) {
      view.append(el("div", { class: "loading", text: "Loading" }));
    }
  }, 150);

  try {
    await render(view);
  } catch (error) {
    if (error && error.statusCode === 401) {
      clearKey();
      boot();
      return;
    }
    const retry = el("button", { text: "retry" });
    retry.addEventListener("click", () => route());
    clear(view);
    view.append(
      notice("error", error && error.message ? error.message : "Failed to load"),
      retry
    );
  } finally {
    clearTimeout(loadingTimer);
    const loading = view.querySelector(".loading");
    if (loading && view.children.length > 1) loading.remove();
  }
}

/* Keyboard: the console answers to keys. Inert while typing in a field. */

function clickableRows() {
  return [...view.querySelectorAll("tr.clickable")];
}

function setSelectedRow(index) {
  const rows = clickableRows();
  if (rows.length === 0) return;
  selectedRow = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((row, i) => row.classList.toggle("row-selected", i === selectedRow));
  rows[selectedRow].scrollIntoView({ block: "nearest" });
}

function clearSelectedRow() {
  selectedRow = -1;
  for (const row of clickableRows()) row.classList.remove("row-selected");
}

function toggleKeymap() {
  const existing = document.getElementById("keymap-overlay");
  if (existing) {
    existing.remove();
    return;
  }

  const overlay = el("div", { id: "keymap-overlay", class: "keymap-overlay" }, [
    el("div", { class: "keymap-panel" }, [
      el("div", { class: "keymap-title", text: "keymap" }),
      el("dl", { class: "keymap-list" }, KEYMAP.flatMap(([key, action]) => [
        el("dt", {}, el("kbd", { text: key })),
        el("dd", { text: action })
      ])),
      el("div", { class: "keymap-foot", text: "esc to close" })
    ])
  ]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

function isTyping() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

document.addEventListener("keydown", (event) => {
  if (!getStoredKey()) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "Escape") {
    const overlay = document.getElementById("keymap-overlay");
    if (overlay) {
      overlay.remove();
    } else if (isTyping()) {
      document.activeElement.blur();
    } else {
      clearSelectedRow();
    }
    return;
  }

  if (isTyping()) return;

  if (event.key >= "1" && event.key <= "7") {
    const route = ROUTES[Number(event.key) - 1];
    if (route) window.location.hash = `#/${route.path}`;
    return;
  }

  switch (event.key) {
    case "j":
      setSelectedRow(selectedRow + 1);
      break;
    case "k":
      setSelectedRow(selectedRow - 1);
      break;
    case "Enter": {
      const rows = clickableRows();
      if (selectedRow >= 0 && rows[selectedRow]) rows[selectedRow].click();
      break;
    }
    case "/": {
      const filter = view.querySelector("input[type=search]");
      if (filter) {
        event.preventDefault();
        filter.focus();
        filter.select();
      }
      break;
    }
    case "r":
      route();
      break;
    case "?":
      toggleKeymap();
      break;
  }
});

function boot() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }

  if (!getStoredKey()) {
    sidebar.hidden = true;
    topbar.hidden = true;
    app.classList.add("connecting");
    document.title = "connect - hubolt";
    renderConnect(view, () => boot());
    return;
  }

  app.classList.remove("connecting");
  sidebar.hidden = false;
  topbar.hidden = false;
  applyRole();
  buildNav();
  buildSidebarFoot();
  pollHealth();
  healthTimer = setInterval(pollHealth, 30000);
  route();
}

// Tag the document with the current key's role so admin-only controls hide for
// viewers (CSS). The server still enforces access; this is only presentation.
async function applyRole() {
  let role = "admin";
  try {
    role = (await api.me()).role || "admin";
  } catch {
    /* default to admin view; the server is the real gate */
  }
  document.body.classList.toggle("role-viewer", role !== "admin");
}

window.addEventListener("hashchange", () => {
  if (getStoredKey()) {
    route();
  }
});

boot();
