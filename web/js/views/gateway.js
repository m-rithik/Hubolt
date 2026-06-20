import { api } from "../api.js";
import { el, table, section, statStrip, emptyState, emptyWithCommand, notice, flashNotice, confirmInline, formatCount, formatUsd, formatDate } from "../dom.js";

export async function renderGateway(container, state = {}) {
  let status;
  try {
    const result = await api.gatewayStatus();
    status = result.status;
  } catch (error) {
    container.replaceChildren(
      section(
        "Gateway",
        null,
        error.statusCode === 404
          ? emptyWithCommand(
              "the LLM gateway is not enabled - start the server with Redis available:",
              "REDIS_URL=redis://localhost:6379 hubolt server"
            )
          : emptyState(`gateway status unavailable: ${error.message}`)
      )
    );
    return;
  }

  const messageSlot = el("div");
  if (state.flash) {
    messageSlot.append(flashNotice(state.flash));
  }

  const credentialsBody =
    status.configuredProviders.length === 0
      ? emptyState("No provider credentials configured.")
      : table(
          ["Provider", "Last used", ""],
          status.configuredProviders.map((entry) => {
            const remove = el("button", { class: "quiet-danger admin-only", text: "Remove" });
            remove.addEventListener("click", (event) => {
              confirmInline(event.target.closest("td"), async () => {
                try {
                  await api.removeCredential(entry.provider);
                  await renderGateway(container, { flash: `${entry.provider} key removed` });
                } catch (error) {
                  messageSlot.replaceChildren(notice("error", error.message));
                }
              });
            });
            return el("tr", {}, [
              el("td", { text: entry.provider }),
              el("td", { class: "dim", text: entry.lastUsed ? formatDate(entry.lastUsed) : "never" }),
              el("td", { class: "actions" }, remove)
            ]);
          })
        );

  const queue = status.queueStatus;

  const modelRows = [];
  for (const [provider, models] of Object.entries(status.availableModels ?? {})) {
    for (const [modelId, info] of Object.entries(models ?? {})) {
      if (info && info.available === false) continue;
      modelRows.push(
        el("tr", {}, [
          el("td", { class: "dim", text: provider }),
          el("td", { class: "mono", text: modelId }),
          el("td", {
            class: "num",
            text: info && typeof info.costPer1kTokens === "number" ? `$${info.costPer1kTokens}` : "-"
          }),
          el("td", { class: "num dim", text: String(info?.quality ?? "-") })
        ])
      );
    }
  }

  const usage = status.usage ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    avgDurationMs: 0,
    byProvider: []
  };

  const usageSection = section(
    "Usage",
    "Input/output token and cost totals across all gateway requests.",
    usage.requests === 0
      ? emptyState("No gateway requests recorded yet.")
      : [
          statStrip([
            { value: formatCount(usage.inputTokens), label: "Input tokens" },
            { value: formatCount(usage.outputTokens), label: "Output tokens" },
            { value: formatCount(usage.totalTokens), label: "Total tokens" },
            { value: formatUsd(usage.costUsd), label: "Est. cost" },
            { value: formatCount(usage.requests), label: "Requests" },
            { value: `${formatCount(usage.avgDurationMs)} ms`, label: "Avg latency" }
          ]),
          el(
            "div",
            { style: "margin-top:16px" },
            table(
              [
                "Provider",
                { label: "Requests", numeric: true },
                { label: "Input tokens", numeric: true },
                { label: "Output tokens", numeric: true },
                { label: "Cost", numeric: true }
              ],
              usage.byProvider.map((p) =>
                el("tr", {}, [
                  el("td", { class: "dim", text: p.provider }),
                  el("td", { class: "num", text: formatCount(p.requests) }),
                  el("td", { class: "num", text: formatCount(p.inputTokens) }),
                  el("td", { class: "num", text: formatCount(p.outputTokens) }),
                  el("td", { class: "num", text: formatUsd(p.costUsd) })
                ])
              )
            )
          )
        ]
  );

  container.replaceChildren(
    messageSlot,
    usageSection,
    section(
      "Provider credentials",
      "Keys are encrypted at rest and never shown after saving.",
      [
        credentialsBody,
        el("div", { class: "panel admin-only", style: "margin-top:16px" }, credentialForm(messageSlot, container))
      ]
    ),
    section("Queue", null, statStrip([
      { value: formatCount(queue.waiting ?? 0), label: "Waiting" },
      { value: formatCount(queue.active ?? 0), label: "Active" },
      { value: formatCount(queue.completed ?? 0), label: "Completed" },
      { value: formatCount(queue.failed ?? 0), label: "Failed" },
      { value: formatCount(queue.delayed ?? 0), label: "Delayed" },
      { value: queue.paused ? "Paused" : "Running", label: "State" }
    ])),
    section(
      "Model catalog",
      "Models the router can select, with estimated cost per thousand tokens.",
      modelRows.length === 0
        ? emptyState("No models listed.")
        : table(
            ["Provider", "Model", { label: "Cost / 1k tokens", numeric: true }, { label: "Quality", numeric: true }],
            modelRows
          )
    )
  );
}

function credentialForm(messageSlot, container) {
  const provider = el("select", {}, [
    el("option", { value: "anthropic", text: "anthropic" }),
    el("option", { value: "openai", text: "openai" }),
    el("option", { value: "google", text: "google" })
  ]);
  const key = el("input", { type: "password", placeholder: "Provider API key", autocomplete: "off" });
  const submit = el("button", { class: "primary", type: "submit", text: "Store key" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Provider" }), provider]),
    el("div", { class: "field" }, [el("label", { text: "API key" }), key]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = key.value.trim();
    if (value.length < 10) {
      messageSlot.replaceChildren(notice("error", "API key looks too short"));
      return;
    }

    submit.disabled = true;
    submit.textContent = "storing...";
    try {
      await api.configureCredential(provider.value, value);
      key.value = "";
      await renderGateway(container, { flash: `${provider.value} key stored (encrypted)` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Store key";
    }
  });

  return form;
}
