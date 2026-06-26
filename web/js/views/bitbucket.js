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

  const messageSlot = el("div");
  if (state.flash) {
    messageSlot.append(flashNotice(state.flash));
  }

  const statusText = (configured, fromEnv) =>
    configured ? (fromEnv ? "set (from .env)" : "set (stored)") : "not set";

  const row = (label, field, configured, fromEnv) => {
    const cells = [
      el("td", { text: label }),
      el("td", { class: configured ? "" : "dim", text: statusText(configured, fromEnv) })
    ];
    // Only stored values can be cleared here; env values live in .env.
    if (configured && !fromEnv) {
      const remove = el("button", { class: "quiet-danger admin-only", text: "Clear" });
      remove.addEventListener("click", (event) => {
        confirmInline(event.target.closest("td"), async () => {
          try {
            await api.clearBitbucketConfig(field);
            await renderBitbucket(container, { flash: `${label} cleared` });
          } catch (error) {
            messageSlot.replaceChildren(notice("error", error.message));
          }
        });
      });
      cells.push(el("td", { class: "actions" }, remove));
    } else {
      cells.push(el("td", {}));
    }
    return el("tr", {}, cells);
  };

  const statusTable = table(
    ["Setting", "Status", ""],
    [
      row("API token", "token", cfg.tokenConfigured, cfg.tokenFromEnv),
      row("Webhook secret", "secret", cfg.webhookSecretConfigured, cfg.webhookSecretFromEnv)
    ]
  );

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
      "Bitbucket",
      "Configure the Bitbucket review bot here instead of editing .env. Secrets are encrypted at rest and never shown after saving.",
      [statusTable, el("div", { class: "panel admin-only", style: "margin-top:16px" }, configForm(messageSlot, container)), webhookHint]
    ),
    section(
      "Review model",
      "Which provider and model write the review. Uses the provider's API key from the environment.",
      [
        el("p", { class: "dim", text: activeText }),
        el("div", { class: "panel admin-only", style: "margin-top:8px" }, reviewModelForm(cfg, messageSlot, container))
      ]
    )
  );
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

function configForm(messageSlot, container) {
  const token = el("input", { type: "password", placeholder: "Repository Access Token (ATCTT...)", autocomplete: "off" });
  const secret = el("input", { type: "password", placeholder: "Webhook secret", autocomplete: "off" });
  const submit = el("button", { class: "primary", type: "submit", text: "Save" });

  const form = el("form", {}, [
    el("div", { class: "form-row" }, [
      el("div", { class: "field" }, [el("label", { text: "API token" }), token]),
      el("div", { class: "field" }, [el("label", { text: "Webhook secret" }), secret]),
      submit
    ])
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {};
    if (token.value.trim()) body.apiToken = token.value.trim();
    if (secret.value.trim()) body.webhookSecret = secret.value.trim();
    if (Object.keys(body).length === 0) {
      messageSlot.replaceChildren(notice("error", "Enter an API token, a webhook secret, or both"));
      return;
    }

    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.saveBitbucketConfig(body);
      token.value = "";
      secret.value = "";
      await renderBitbucket(container, { flash: "Bitbucket configuration saved (encrypted)" });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Save";
    }
  });

  return form;
}
