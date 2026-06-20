import { api } from "../api.js";
import { el, table, section, emptyState, notice, flashNotice, confirmInline, formatDate } from "../dom.js";

export async function renderOrganization(container, state = {}) {
  const org = await api.org();
  const messageSlot = el("div");
  if (state.flash) {
    messageSlot.append(flashNotice(state.flash));
  }
  if (state.newKey) {
    messageSlot.append(newKeyNotice(state.newKey));
  }

  const info = el("dl", { class: "kv" }, [
    el("dt", { text: "Name" }),
    el("dd", { text: org.name }),
    el("dt", { text: "Slug" }),
    el("dd", { class: "mono", text: org.slug }),
    el("dt", { text: "Members" }),
    el("dd", { text: String(org.members.length) })
  ]);

  const membersBody =
    org.members.length === 0
      ? emptyState("No members.")
      : table(
          ["Name", "Email", "Role", ""],
          org.members.map((member) =>
            el("tr", {}, [
              el("td", { text: member.name || "-" }),
              el("td", { class: "dim", text: member.email }),
              el("td", {}, el("span", { class: `role-badge role-${member.role === "admin" ? "admin" : "viewer"}`, text: member.role })),
              el("td", { class: "actions" }, memberActions(member, messageSlot, container))
            ])
          )
        );

  const keysBody =
    org.apiKeys.length === 0
      ? emptyState("No API keys.")
      : table(
          ["Name", "Role", "Owner", "Created", "Last used", "Expires", ""],
          org.apiKeys.map((key) =>
            el("tr", {}, [
              el("td", { text: key.name }),
              el("td", {}, el("span", { class: `role-badge role-${key.role === "admin" ? "admin" : "viewer"}`, text: key.role || "admin" })),
              el("td", {}, ownerCell(key, org.members, messageSlot, container)),
              el("td", { class: "dim", text: formatDate(key.createdAt) }),
              el("td", { class: "dim", text: key.lastUsedAt ? formatDate(key.lastUsedAt) : "never" }),
              el("td", { class: "dim", text: key.expiresAt ? formatDate(key.expiresAt) : "never" }),
              el("td", { class: "actions" }, keyActions(key, messageSlot, container))
            ])
          )
        );

  container.replaceChildren(
    messageSlot,
    section("Details", null, [
      info,
      el("div", { class: "panel admin-only", style: "margin-top:16px" }, renameForm(org, messageSlot, container))
    ]),
    section("Members", "Members and their roles are organizational; access is controlled by API key roles.", [
      membersBody,
      el("div", { class: "panel admin-only", style: "margin-top:16px" }, addMemberForm(messageSlot, container))
    ]),
    section(
      "API keys",
      "Key values are shown once at creation and never stored. Admin keys can change settings; viewer keys are read-only.",
      [
        keysBody,
        // admin-only: a viewer cannot mint keys (the server also enforces this).
        el("div", { class: "panel admin-only", style: "margin-top:16px" }, createKeyForm(org.members, messageSlot, container))
      ]
    )
  );
}

const MEMBER_ROLES = ["admin", "reviewer", "viewer"];

// Per-member admin controls: change role or remove. Admin-only.
function memberActions(member, messageSlot, container) {
  const role = el("select", { class: "key-role" }, MEMBER_ROLES.map((r) => el("option", { value: r, text: r })));
  role.value = member.role;
  role.addEventListener("change", async () => {
    try {
      await api.updateMemberRole(member.id, role.value);
      await renderOrganization(container, { flash: `${member.email} is now ${role.value}` });
    } catch (error) {
      role.value = member.role;
      messageSlot.replaceChildren(notice("error", error.message));
    }
  });

  const remove = el("button", { class: "quiet-danger", text: "Remove" });
  remove.addEventListener("click", (event) => {
    confirmInline(event.target.closest("td"), async () => {
      try {
        await api.removeMember(member.id);
        await renderOrganization(container, { flash: `${member.email} removed` });
      } catch (error) {
        messageSlot.replaceChildren(notice("error", error.message));
      }
    });
  });

  return el("span", { class: "key-actions admin-only" }, [role, remove]);
}

function addMemberForm(messageSlot, container) {
  const email = el("input", { type: "email", placeholder: "person@example.com", autocomplete: "off" });
  const name = el("input", { type: "text", placeholder: "name (optional)", autocomplete: "off" });
  const role = el("select", {}, MEMBER_ROLES.map((r) => el("option", { value: r, text: r })));
  role.value = "viewer";
  const submit = el("button", { class: "primary", type: "submit", text: "Add member" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Email" }), email]),
    el("div", { class: "field" }, [el("label", { text: "Name" }), name]),
    el("div", { class: "field" }, [el("label", { text: "Role" }), role]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = email.value.trim();
    if (!value) {
      messageSlot.replaceChildren(notice("error", "Enter an email"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "adding...";
    try {
      await api.addMember({ email: value, name: name.value.trim() || undefined, role: role.value });
      await renderOrganization(container, { flash: `${value} added as ${role.value}` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Add member";
    }
  });

  return form;
}

function renameForm(org, messageSlot, container) {
  const name = el("input", { type: "text", autocomplete: "off" });
  name.value = org.name;
  const submit = el("button", { class: "primary", type: "submit", text: "Rename" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Organization name" }), name]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) {
      messageSlot.replaceChildren(notice("error", "Enter a name"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "saving...";
    try {
      await api.renameOrg(value);
      await renderOrganization(container, { flash: "Organization renamed" });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Rename";
    }
  });

  return form;
}

// Per-key admin controls: change the role, or revoke the key. The whole group
// is admin-only, so viewers never see it (the server also enforces this).
function keyActions(key, messageSlot, container) {
  const role = el("select", { class: "key-role" }, [
    el("option", { value: "viewer", text: "viewer" }),
    el("option", { value: "admin", text: "admin" })
  ]);
  role.value = key.role || "admin";
  role.addEventListener("change", async () => {
    const next = role.value;
    try {
      await api.updateApiKey(key.id, { role: next });
      await renderOrganization(container, { flash: `${key.name} is now ${next}` });
    } catch (error) {
      role.value = key.role || "admin";
      messageSlot.replaceChildren(notice("error", error.message));
    }
  });

  const remove = el("button", { class: "quiet-danger", text: "Remove" });
  remove.addEventListener("click", (event) => {
    confirmInline(event.target.closest("td"), async () => {
      try {
        await api.deleteApiKey(key.id);
        await renderOrganization(container, { flash: `${key.name} removed` });
      } catch (error) {
        messageSlot.replaceChildren(notice("error", error.message));
      }
    });
  });

  return el("span", { class: "key-actions admin-only" }, [role, remove]);
}

// Key owner: viewers see the email (or "unassigned"); admins get a dropdown to
// (re)assign the key to a member.
function ownerCell(key, members, messageSlot, container) {
  const text = el("span", { class: "owner-text dim", text: key.member ? key.member.email : "unassigned" });

  const select = el("select", { class: "owner-select key-role admin-only" }, [
    el("option", { value: "", text: "unassigned" }),
    ...members.map((m) => el("option", { value: m.id, text: m.email }))
  ]);
  select.value = key.memberId || "";
  select.addEventListener("change", async () => {
    try {
      await api.updateApiKey(key.id, { memberId: select.value || null });
      await renderOrganization(container, { flash: `${key.name} ${select.value ? "assigned" : "unassigned"}` });
    } catch (error) {
      select.value = key.memberId || "";
      messageSlot.replaceChildren(notice("error", error.message));
    }
  });

  return el("span", { class: "owner-cell" }, [text, select]);
}

const KEY_REVEAL_SECONDS = 30;

function newKeyNotice(key) {
  const code = el("code", { class: "mono new-key", text: key.key });
  const copy = el("button", { class: "primary", type: "button", text: "Copy" });
  const countdown = el("span", { class: "dim new-key-countdown", text: `${KEY_REVEAL_SECONDS}s` });

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(key.key);
      copy.textContent = "Copied";
      setTimeout(() => {
        if (copy.isConnected) copy.textContent = "Copy";
      }, 1500);
    } catch {
      // Clipboard API needs a secure context; fall back to selecting the text.
      selectText(code);
      copy.textContent = "Press Cmd/Ctrl+C";
    }
  });

  const wrap = el("div", { class: "notice ok" }, [
    el("div", {
      text: `New ${key.role} key "${key.name}" created. Copy it now - it is shown for ${KEY_REVEAL_SECONDS} seconds and never again.`
    }),
    el("div", { class: "new-key-row" }, [code, copy, countdown])
  ]);

  // Reveal window: tick down, then scrub the key from the DOM.
  let remaining = KEY_REVEAL_SECONDS;
  const timer = setInterval(() => {
    if (!wrap.isConnected) {
      clearInterval(timer);
      return;
    }
    remaining -= 1;
    countdown.textContent = `${Math.max(remaining, 0)}s`;
    if (remaining <= 0) {
      clearInterval(timer);
      wrap.replaceChildren(
        el("div", { class: "dim", text: "Key hidden. Create a new one if you did not copy it in time." })
      );
    }
  }, 1000);

  return wrap;
}

function selectText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function createKeyForm(members, messageSlot, container) {
  const name = el("input", { type: "text", placeholder: "e.g. ci-readonly", autocomplete: "off" });
  const role = el("select", {}, [
    el("option", { value: "viewer", text: "viewer (read-only)" }),
    el("option", { value: "admin", text: "admin (full access)" })
  ]);
  const owner = el("select", {}, [
    el("option", { value: "", text: "unassigned" }),
    ...members.map((m) => el("option", { value: m.id, text: m.email }))
  ]);
  const expiry = el("select", {}, [
    el("option", { value: "", text: "never" }),
    el("option", { value: "30", text: "30 days" }),
    el("option", { value: "90", text: "90 days" }),
    el("option", { value: "365", text: "1 year" })
  ]);
  const submit = el("button", { class: "primary", type: "submit", text: "Create key" });

  const form = el("form", { class: "form-row" }, [
    el("div", { class: "field", style: "flex:1" }, [el("label", { text: "Key name" }), name]),
    el("div", { class: "field" }, [el("label", { text: "Role" }), role]),
    el("div", { class: "field" }, [el("label", { text: "Owner" }), owner]),
    el("div", { class: "field" }, [el("label", { text: "Expires" }), expiry]),
    submit
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) {
      messageSlot.replaceChildren(notice("error", "Give the key a name"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "creating...";
    try {
      const body = { name: value, role: role.value };
      if (owner.value) body.memberId = owner.value;
      if (expiry.value) body.expiresInDays = Number(expiry.value);
      const created = await api.createApiKey(body);
      await renderOrganization(container, { newKey: created });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Create key";
    }
  });

  return form;
}
