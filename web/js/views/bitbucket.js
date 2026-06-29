import { api } from "../api.js";
import { el, table, section, emptyState, notice, flashNotice, confirmInline } from "../dom.js";

export async function renderBitbucket(container, state = {}) {
  let cfg;
  try {
    cfg = await api.bitbucketConfig();
  } catch (error) {
    container.replaceChildren(section("Bitbucket", null, emptyState(`configuration unavailable: ${error.message}`)));
    return;
  }

  const integ = await api.integrations().catch(() => ({ integrations: [], repos: [] }));

  const messageSlot = el("div");
  if (state.flash) {
    messageSlot.append(flashNotice(state.flash));
  }

  const webhookHint = el("div", { class: "panel", style: "margin-top:16px" }, [
    el("div", { class: "field-label", text: "Webhook URL" }),
    el("code", { class: "mono", text: `https://<your-public-url>${cfg.webhookPath || "/webhooks/bitbucket"}` }),
    el("p", { class: "dim", text:
      "In Bitbucket: Repository settings > Webhooks > Add webhook. Trigger on " +
      "Pull Request Created and Updated, and set the same secret you save here." }),
    el("p", { class: "dim", text:
      "API token: Repository settings > Access tokens > Create Repository Access Token " +
      "with the Pull requests: Write scope (starts with ATCTT)." })
  ]);

  const active = cfg.activeModel || {};
  const activeText =
    active.provider && active.model ? `Active: ${active.provider} / ${active.model}` : "No model selected (server default applies)";

  container.replaceChildren(
    messageSlot,
    section(
      "Repository integrations",
      "Each repository has its own named integration: one repo, one API token, one webhook secret. Tokens and secrets cannot be reused across integrations.",
      [
        integrationsTable(integ, messageSlot, container),
        el("div", { class: "panel admin-only", style: "margin-top:16px" }, integrationForm(integ, messageSlot, container)),
        webhookHint
      ]
    ),
    section(
      "Review model",
      "Which provider and model write the review. Uses the provider's API key from the environment.",
      [
        el("p", { class: "dim", text: activeText }),
        el("div", { class: "panel admin-only", style: "margin-top:8px" }, reviewModelForm(cfg, messageSlot, container))
      ]
    ),
    section(
      "Severity threshold",
      "Reviews report findings at or above this severity. Lower it to surface more.",
      [
        el("p", { class: "dim", text: `Current: ${cfg.activeThreshold || "repo default (.hubolt.yml)"}` }),
        el("div", { class: "panel admin-only", style: "margin-top:8px" }, thresholdForm(cfg, messageSlot, container))
      ]
    )
  );
}

function thresholdForm(cfg, messageSlot, container) {
  const levels = cfg.severityLevels || ["info", "low", "medium", "high", "critical"];
  const select = el("select", {}, levels.map((l) => el("option", { value: l, text: l })));
  if (cfg.activeThreshold) select.value = cfg.activeThreshold;
  const submit = el("button", { class: "primary", type: "submit", text: "Set threshold" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Report at or above" }), select]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.setBitbucketThreshold(select.value);
      await renderBitbucket(container, { flash: `Severity threshold set to ${select.value}` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Set threshold";
    }
  });

  return form;
}

function integrationsTable(integ, messageSlot, container) {
  const rows = integ.integrations || [];
  if (rows.length === 0) {
    return emptyState("No repository integrations yet. Add one below.");
  }
  return table(
    ["Name", "Repository", "Token", "Webhook", "Slack", ""],
    rows.map((r) => {
      const remove = el("button", { class: "quiet-danger admin-only", text: "Remove" });
      remove.addEventListener("click", (event) => {
        confirmInline(event.target.closest("td"), async () => {
          try {
            await api.deleteIntegration(r.repoId);
            await renderBitbucket(container, { flash: `Integration "${r.name}" removed` });
          } catch (error) {
            messageSlot.replaceChildren(notice("error", error.message));
          }
        });
      });
      return el("tr", {}, [
        el("td", { text: r.name }),
        el("td", { class: "mono", text: r.repoFullName || r.repoId }),
        el("td", { class: "mono dim", text: r.tokenLast4 ? `••${r.tokenLast4}` : "configured" }),
        el("td", { class: "dim", text: r.webhookSecretConfigured ? "set" : "-" }),
        el("td", { class: "dim", text: r.slackConfigured ? "set" : "-" }),
        el("td", { class: "actions" }, remove)
      ]);
    })
  );
}

function integrationForm(_integ, messageSlot, container) {
  // One coherent form: type the Bitbucket repo, name it, paste its credentials.
  // The repo record is created automatically; provider is always Bitbucket here.
  const repoFullName = el("input", { type: "text", placeholder: "workspace/repo  (e.g. acme/payments)", autocomplete: "off" });
  const name = el("input", { type: "text", placeholder: "e.g. Payments Service Bitbucket Connection", autocomplete: "off" });
  const token = el("input", { type: "password", placeholder: "Repository Access Token (ATCTT...)", autocomplete: "off" });
  const secret = el("input", { type: "password", placeholder: "Webhook secret", autocomplete: "off" });
  const slack = el("input", { type: "password", placeholder: "https://hooks.slack.com/services/...", autocomplete: "off" });
  const submit = el("button", { class: "primary", type: "submit", text: "Add integration" });

  const form = el("form", {}, [
    el("div", { class: "field" }, [el("label", { text: "Bitbucket repository" }), repoFullName]),
    el("div", { class: "field", style: "margin-top:8px" }, [el("label", { text: "Integration name" }), name]),
    el("div", { class: "form-row", style: "margin-top:8px" }, [
      el("div", { class: "field" }, [el("label", { text: "API token" }), token]),
      el("div", { class: "field" }, [el("label", { text: "Webhook secret" }), secret]),
      submit
    ]),
    el("div", { class: "field", style: "margin-top:8px" }, [
      el("label", { text: "Slack webhook (optional)" }),
      slack,
      el("p", { class: "dim", text: "Optional. If set, this repository's review notifications go only to this Slack webhook - not to any common/org-wide one." })
    ])
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!repoFullName.value.trim() || !name.value.trim() || !token.value.trim() || !secret.value.trim()) {
      messageSlot.replaceChildren(notice("error", "Repository, name, API token, and webhook secret are required"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      const body = {
        repoFullName: repoFullName.value.trim(),
        name: name.value.trim(),
        token: token.value.trim(),
        webhookSecret: secret.value.trim()
      };
      if (slack.value.trim()) body.slackWebhookUrl = slack.value.trim();
      await api.createIntegration(body);
      await renderBitbucket(container, { flash: `Integration "${body.name}" added` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Add integration";
    }
  });

  return form;
}

function reviewModelForm(cfg, messageSlot, container) {
  const providers = cfg.providers || [];
  const active = cfg.activeModel || {};

  const provider = el(
    "select",
    {},
    providers.map((p) =>
      el("option", { value: p.id, text: p.keyPresent ? p.label : `${p.label} (no key)` })
    )
  );
  if (active.provider) provider.value = active.provider;

  const selected = providers.find((p) => p.id === provider.value) || providers[0];
  const modelInput = el("input", { type: "text", placeholder: selected?.defaultModel || "model id", autocomplete: "off" });
  modelInput.value = active.model || selected?.defaultModel || "";

  // Switching provider suggests its default model unless the user typed one.
  provider.addEventListener("change", () => {
    const next = providers.find((p) => p.id === provider.value);
    if (next) modelInput.value = next.defaultModel;
  });

  const submit = el("button", { class: "primary", type: "submit", text: "Set active model" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Provider" }), provider]),
    el("div", { class: "field" }, [el("label", { text: "Model" }), modelInput]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = modelInput.value.trim();
    if (!model) {
      messageSlot.replaceChildren(notice("error", "Enter a model id"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.setBitbucketModel({ provider: provider.value, model });
      await renderBitbucket(container, { flash: `Active model set to ${provider.value} / ${model}` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Set active model";
    }
  });

  return form;
}
