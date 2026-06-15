import { api } from "../api.js";
import { el, table, section, usageBar, emptyState, notice, flashNotice, confirmInline, formatUsd } from "../dom.js";

export async function renderBudgets(container, state = {}) {
  const result = await api.budgets();
  const messageSlot = el("div");
  if (state.flash) {
    messageSlot.append(flashNotice(state.flash));
  }

  const body =
    result.budgets.length === 0
      ? emptyState("No budgets configured. Gateway requests are not cost-capped until one exists.")
      : table(
          ["Provider", { label: "Limit / month", numeric: true }, { label: "Used", numeric: true }, "Usage", { label: "Alert at", numeric: true }, ""],
          result.budgets.map((budget) => {
            const remove = el("button", { class: "quiet-danger", text: "Remove" });
            remove.addEventListener("click", (event) => {
              confirmInline(event.target.closest("td"), async () => {
                try {
                  await api.deleteBudget(budget.provider);
                  await renderBudgets(container, { flash: `${budget.provider} budget removed` });
                } catch (error) {
                  messageSlot.replaceChildren(notice("error", error.message));
                }
              });
            });

            return el("tr", {}, [
              el("td", { text: budget.provider }),
              el("td", { class: "num", text: formatUsd(budget.monthlyLimitUsd) }),
              el("td", { class: "num", text: formatUsd(budget.currentMonthCostUsd) }),
              el("td", {}, usageBar(budget.percentageUsed, budget.alertThresholdPct)),
              el("td", { class: "num dim", text: `${budget.alertThresholdPct}%` }),
              el("td", { class: "actions" }, remove)
            ]);
          })
        );

  container.replaceChildren(
    messageSlot,
    section("Monthly budgets", "Per-provider spending limits enforced by the gateway.", body),
    section(
      "Add or update a budget",
      "Saving an existing provider overwrites its limit and threshold.",
      el("div", { class: "panel" }, budgetForm(messageSlot, container))
    )
  );
}

function budgetForm(messageSlot, container) {
  const provider = el("select", {}, [
    el("option", { value: "anthropic", text: "anthropic" }),
    el("option", { value: "openai", text: "openai" }),
    el("option", { value: "google", text: "google" })
  ]);
  const limit = el("input", { type: "number", min: "0.01", step: "0.01", placeholder: "100.00" });
  const threshold = el("input", { type: "number", min: "1", max: "100", value: "80" });
  const submit = el("button", { class: "primary", type: "submit", text: "Save budget" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Provider" }), provider]),
    el("div", { class: "field" }, [el("label", { text: "Monthly limit (USD)" }), limit]),
    el("div", { class: "field" }, [el("label", { text: "Alert threshold (%)" }), threshold]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const monthlyLimitUsd = Number.parseFloat(limit.value);
    const alertThresholdPct = Number.parseInt(threshold.value, 10);

    if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0) {
      messageSlot.replaceChildren(notice("error", "Monthly limit must be a positive amount"));
      return;
    }

    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.createBudget({ provider: provider.value, monthlyLimitUsd, alertThresholdPct });
      await renderBudgets(container, { flash: `${provider.value} budget saved` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Save budget";
    }
  });

  return form;
}
