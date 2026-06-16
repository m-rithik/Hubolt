import { api, storeKey, clearKey } from "../api.js";
import { el, notice } from "../dom.js";

/**
 * First-run screen: collects the server API key, verifies it against
 * /orgs/current, and stores it locally on success.
 */
export function renderConnect(container, onConnected) {
  const errorSlot = el("div");
  const input = el("input", {
    type: "password",
    placeholder: "hubolt_...",
    autocomplete: "off",
    spellcheck: "false"
  });
  const submit = el("button", { class: "primary", type: "submit", text: "Connect" });

  const form = el("form", {}, [
    errorSlot,
    el("div", { class: "field" }, [el("label", { text: "API key" }), input]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = input.value.trim();
    if (!key) return;

    submit.disabled = true;
    errorSlot.replaceChildren();
    storeKey(key);

    try {
      await api.org();
      onConnected();
    } catch (error) {
      // The key has to be stored before verifying (the request helper reads it
      // from storage), so a failed check must clear it again - otherwise an
      // invalid key persists and bounces the next page load through the app.
      clearKey();
      errorSlot.replaceChildren(
        notice("error", error.statusCode === 401 ? "Invalid API key" : error.message)
      );
      submit.disabled = false;
    }
  });

  container.replaceChildren(
    el("div", { class: "connect-wrap" }, [
      el("div", { class: "connect-box" }, [
        el("div", { class: "wordmark" }, [
          el("span", { class: "wordmark-dot" }),
          el("span", { class: "wordmark-text", text: "hubolt" })
        ]),
        el("h1", { text: "Control panel" }),
        el("p", {
          text: "Enter an organization API key for this server. Create one with hubolt server bootstrap."
        }),
        form
      ])
    ])
  );

  input.focus();
}
