import { api, storeKey, clearKey } from "../api.js";
import { el, notice } from "../dom.js";

/**
 * First-run screen. Primary path is username/password login (issues a session
 * token); an API key is offered as a secondary option for machine/CI access.
 * Both store a Bearer token locally that the rest of the app uses.
 */
export function renderConnect(container, onConnected) {
  const errorSlot = el("div");

  // --- Username / password login ---
  const username = el("input", { type: "text", placeholder: "username", autocomplete: "username", spellcheck: "false" });
  const password = el("input", { type: "password", placeholder: "password", autocomplete: "current-password" });
  const loginBtn = el("button", { class: "primary", type: "submit", text: "Log in" });

  const loginForm = el("form", {}, [
    el("div", { class: "field" }, [el("label", { text: "Username" }), username]),
    el("div", { class: "field", style: "margin-top:8px" }, [el("label", { text: "Password" }), password]),
    el("div", { style: "margin-top:12px" }, loginBtn)
  ]);

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!username.value.trim() || !password.value) return;
    loginBtn.disabled = true;
    errorSlot.replaceChildren();
    try {
      const result = await api.login(username.value.trim(), password.value);
      storeKey(result.token);
      if (result.mustChangePassword) {
        renderForcedPasswordChange(container, username.value.trim(), password.value, onConnected);
        return;
      }
      onConnected();
    } catch (error) {
      errorSlot.replaceChildren(
        notice("error", error.statusCode === 401 ? "Invalid username or password" : error.message)
      );
      loginBtn.disabled = false;
    }
  });

  // --- API key (secondary) ---
  const keyInput = el("input", { type: "password", placeholder: "hubolt_...", autocomplete: "off", spellcheck: "false" });
  const keyBtn = el("button", { type: "submit", text: "Use API key" });
  const keyForm = el("form", { style: "margin-top:12px" }, [
    el("div", { class: "field" }, [el("label", { text: "Or connect with an API key" }), keyInput]),
    el("div", { style: "margin-top:8px" }, keyBtn)
  ]);

  keyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;
    keyBtn.disabled = true;
    errorSlot.replaceChildren();
    storeKey(key);
    try {
      await api.org();
      onConnected();
    } catch (error) {
      clearKey();
      errorSlot.replaceChildren(notice("error", error.statusCode === 401 ? "Invalid API key" : error.message));
      keyBtn.disabled = false;
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
        el("p", { text: "Log in with your username and password." }),
        errorSlot,
        loginForm,
        keyForm
      ])
    ])
  );

  username.focus();
}

/** Shown after login when the account has a temporary, admin-set password. */
function renderForcedPasswordChange(container, username, currentPassword, onConnected) {
  const errorSlot = el("div");
  const next = el("input", { type: "password", placeholder: "new password (min 12 chars)", autocomplete: "new-password" });
  const confirm = el("input", { type: "password", placeholder: "confirm new password", autocomplete: "new-password" });
  const submit = el("button", { class: "primary", type: "submit", text: "Set new password" });

  const form = el("form", {}, [
    errorSlot,
    el("div", { class: "field" }, [el("label", { text: "New password" }), next]),
    el("div", { class: "field", style: "margin-top:8px" }, [el("label", { text: "Confirm" }), confirm]),
    el("div", { style: "margin-top:12px" }, submit)
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (next.value.length < 12) {
      errorSlot.replaceChildren(notice("error", "Password must be at least 12 characters"));
      return;
    }
    if (next.value !== confirm.value) {
      errorSlot.replaceChildren(notice("error", "Passwords do not match"));
      return;
    }
    submit.disabled = true;
    try {
      await api.changePassword({ currentPassword, newPassword: next.value });
      // changePassword rotates sessions; log in again with the new password.
      const result = await api.login(username, next.value).catch(() => null);
      if (result && result.token) {
        storeKey(result.token);
        onConnected();
      } else {
        clearKey();
        renderConnect(container, onConnected);
      }
    } catch (error) {
      errorSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
    }
  });

  container.replaceChildren(
    el("div", { class: "connect-wrap" }, [
      el("div", { class: "connect-box" }, [
        el("h1", { text: "Set a new password" }),
        el("p", { text: "Your password was set by an admin and must be changed before continuing." }),
        form
      ])
    ])
  );
  next.focus();
}
