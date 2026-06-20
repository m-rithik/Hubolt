import { api } from "../api.js";
import {
  el, table, section, emptyState, emptyWithCommand,
  notice, flashNotice, confirmInline, formatCount, formatRelative, setHash
} from "../dom.js";

export async function renderGitHubRepos(container, state = {}) {
  let repoData;
  try {
    repoData = await api.repos();
  } catch (error) {
    container.replaceChildren(
      section("GitHub Repos", null, emptyState(`could not load repositories: ${error.message}`))
    );
    return;
  }

  // Side panels degrade independently: one failure must not blank the page.
  const [model, recent] = await Promise.all([
    api.reviewModel().catch(() => null),
    api.reviews({ limit: 8 }).catch(() => null)
  ]);

  const messageSlot = el("div");
  if (state.flash) messageSlot.append(flashNotice(state.flash));
  if (state.error) messageSlot.append(notice("error", state.error));

  container.replaceChildren(
    messageSlot,
    installSection(repoData),
    reviewEngineSection(model, messageSlot, container),
    processingSection(),
    section(
      "Add repositories",
      "Paste one or more GitHub repository links, one per line. Hubolt reviews every pull request opened on them.",
      el("div", { class: "panel repo-add" }, addForm(messageSlot, container))
    ),
    section(
      "Connected repositories",
      null,
      repoData.repos.length === 0
        ? emptyState("No repositories yet. Add one above to start reviewing its pull requests.")
        : reposTable(repoData, messageSlot, container)
    ),
    recentReviewsSection(recent)
  );
}

function installSection(data) {
  if (!data.appConfigured) {
    return section(
      "GitHub App",
      null,
      emptyWithCommand(
        "The GitHub App is not configured on the server. Set these and restart:",
        "GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... GITHUB_APP_SLUG=... GITHUB_APP_WEBHOOK_SECRET=..."
      )
    );
  }

  const awaiting = data.repos.filter((repo) => !repo.installed).length;
  const desc =
    awaiting > 0
      ? `${awaiting} repositor${awaiting === 1 ? "y is" : "ies are"} waiting for the app before reviews can post.`
      : "Install the app on a repository so Hubolt can read pull requests and post reviews.";

  const banner = el("div", { class: "repo-install" }, [
    el("div", {}, [
      el("div", { class: "repo-install-title", text: "Hubolt GitHub App" }),
      el("div", { class: "repo-install-desc dim", text: desc })
    ]),
    data.installUrl
      ? el("a", { class: "repo-install-btn", href: data.installUrl, target: "_blank", rel: "noreferrer", text: "Install on GitHub" })
      : null
  ]);

  return section("GitHub App", null, banner);
}

function reviewEngineSection(model, messageSlot, container) {
  if (!model || (model.providers || []).length === 0) {
    return section(
      "Review engine",
      "Reviews use a provider you have configured in the Gateway.",
      emptyWithCommand(
        "No LLM credential found in the Gateway. Store one there, then pick the review model here.",
        "open the Gateway tab and store an API key"
      )
    );
  }

  const current =
    model.provider && model.model
      ? `Currently: ${model.provider} / ${model.model}`
      : "No model selected yet - reviews fall back to the server default.";

  return section(
    "Review engine",
    "Reviews use the provider you configured in the Gateway. Choose which model writes the comments.",
    [
      el("p", { class: "section-desc", text: current }),
      el("div", { class: "panel" }, reviewModelForm(model, messageSlot, container))
    ]
  );
}

function reviewModelForm(model, messageSlot, container) {
  const provider = el("select", {}, model.providers.map((p) => el("option", { value: p.id, text: p.label })));
  if (model.provider) provider.value = model.provider;

  const selected = model.providers.find((p) => p.id === provider.value) || model.providers[0];
  const modelInput = el("input", {
    type: "text",
    placeholder: selected?.defaultModel || "model id",
    autocomplete: "off"
  });
  modelInput.value = model.model || selected?.defaultModel || "";

  // Switching provider suggests its default model unless the field holds a
  // value the user typed (i.e. not a known default).
  const knownDefaults = new Set(model.providers.map((p) => p.defaultModel).filter(Boolean));
  provider.addEventListener("change", () => {
    const p = model.providers.find((x) => x.id === provider.value);
    if (p?.defaultModel && (!modelInput.value || knownDefaults.has(modelInput.value))) {
      modelInput.value = p.defaultModel;
    }
  });

  const submit = el("button", { class: "primary", type: "submit", text: "Save model" });
  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Provider" }), provider]),
    el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Model" }), modelInput]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = modelInput.value.trim();
    if (!value) {
      messageSlot.replaceChildren(notice("error", "Enter a model id"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.setReviewModel({ provider: provider.value, model: value });
      await renderGitHubRepos(container, { flash: `Reviews will use ${provider.value} / ${value}` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Save model";
    }
  });

  return form;
}

function processingSection() {
  const body = el("div", {}, el("div", { class: "dim", text: "loading queue..." }));

  const paint = (queue) => {
    if (!body.isConnected) return;
    if (!queue) {
      body.replaceChildren(emptyState("Queue unavailable (Redis not connected)."));
      return;
    }
    body.replaceChildren(
      statTiles([
        { value: formatCount(queue.active ?? 0), label: "Processing now" },
        { value: formatCount(queue.waiting ?? 0), label: "Waiting" },
        { value: formatCount(queue.completed ?? 0), label: "Completed" },
        { value: formatCount(queue.failed ?? 0), label: "Failed" },
        { value: formatCount(queue.delayed ?? 0), label: "Retrying" }
      ])
    );
  };

  const tick = async () => {
    try {
      const status = await api.reviewStatus();
      paint(status.queue);
    } catch {
      /* keep the last painted values */
    }
  };

  tick();
  // Self-clearing poll: stops once this panel leaves the DOM (view change).
  const timer = setInterval(() => {
    if (!body.isConnected) {
      clearInterval(timer);
      return;
    }
    tick();
  }, 4000);

  return section("Processing", "Live review-queue activity. Reviews run on the worker.", body);
}

/** Plain stat tiles (no count-up animation) so live polling does not re-animate. */
function statTiles(items) {
  return el(
    "div",
    { class: "stats" },
    items.map((item) =>
      el("div", { class: "stat" }, [
        el("div", { class: "stat-value", text: item.value }),
        el("div", { class: "stat-label", text: item.label })
      ])
    )
  );
}

function reposTable(data, messageSlot, container) {
  return table(
    ["Repository", "Status", ""],
    data.repos.map((repo) => {
      const remove = el("button", { class: "quiet-danger", text: "Remove" });
      remove.addEventListener("click", (event) => {
        confirmInline(event.target.closest("td"), async () => {
          try {
            await api.deleteRepo(repo.fullName);
            await renderGitHubRepos(container, { flash: `${repo.fullName} removed (its review history is kept)` });
          } catch (error) {
            messageSlot.replaceChildren(notice("error", error.message));
          }
        });
      });

      return el("tr", {}, [
        el("td", {}, el("a", { href: repo.url, target: "_blank", rel: "noreferrer", text: repo.fullName })),
        el("td", {}, el("span", { class: "repo-status" }, [
          el("span", { class: `status-dot ${repo.installed ? "ok" : ""}` }),
          el("span", { class: repo.installed ? "" : "dim", text: repo.installed ? "installed" : "awaiting install" })
        ])),
        el("td", { class: "actions" }, remove)
      ]);
    })
  );
}

function recentReviewsSection(recent) {
  if (!recent) {
    return section("Reviews written", null, emptyState("could not load reviews"));
  }
  const reviews = recent.reviews ?? [];
  if (reviews.length === 0) {
    return section(
      "Reviews written",
      "Reviews Hubolt has posted, newest first.",
      emptyState("No reviews yet. They appear here once a pull request is reviewed.")
    );
  }

  const rows = reviews.map((review) => {
    const tr = el("tr", { class: "clickable" }, [
      el("td", { text: review.repository }),
      el("td", { class: "num", text: formatCount(review.findingCount) }),
      el("td", { class: "dim mono", text: `${review.provider}/${review.model}` }),
      el("td", { class: "dim", text: formatRelative(review.createdAt) })
    ]);
    tr.addEventListener("click", () => setHash(`#/reviews/${encodeURIComponent(review.id)}`));
    return tr;
  });

  return section(
    "Reviews written",
    "Reviews Hubolt has posted, newest first. Click a row to open it.",
    table(["Repository", { label: "Findings", numeric: true }, "Model", "When"], rows)
  );
}

function addForm(messageSlot, container) {
  const input = el("textarea", {
    class: "repo-add-input",
    rows: "3",
    placeholder: "https://github.com/owner/repo\nhttps://github.com/owner/another",
    autocomplete: "off",
    spellcheck: "false"
  });
  const submit = el("button", { class: "primary", type: "submit", text: "Add repositories" });
  const hint = el("div", {
    class: "repo-add-hint dim",
    text: "One per line. Accepts full links, owner/repo, or git@ URLs."
  });

  const form = el("form", { class: "repo-add-form" }, [
    input,
    el("div", { class: "repo-add-actions" }, [hint, submit])
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const urls = [...new Set(input.value.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean))];
    if (urls.length === 0) {
      messageSlot.replaceChildren(notice("error", "Paste at least one GitHub repository link"));
      return;
    }

    submit.disabled = true;
    submit.textContent = urls.length > 1 ? `adding ${urls.length}...` : "adding...";

    const failures = [];
    let added = 0;
    for (const url of urls) {
      try {
        await api.createRepo({ url });
        added += 1;
      } catch (error) {
        failures.push(`${url} (${error.message})`);
      }
    }

    const flash = added > 0 ? (added === 1 ? "Repository added" : `${added} repositories added`) : undefined;
    const error = failures.length > 0 ? `Could not add: ${failures.join("; ")}` : undefined;
    await renderGitHubRepos(container, { flash, error });
  });

  return form;
}
