import { api } from "../api.js";
import { el, table, section, emptyState, notice, flashNotice, confirmInline } from "../dom.js";

/**
 * Admin: create/manage users (username, password, role) and grant each
 * developer access to specific repositories. Developers calling this get a 403,
 * shown as a friendly notice.
 */
export async function renderUsers(container, state = {}) {
  let data;
  try {
    data = await api.users();
  } catch (error) {
    if (error.statusCode === 403) {
      container.replaceChildren(section("Users", null, emptyState("Admins only.")));
      return;
    }
    throw error;
  }

  const messageSlot = el("div");
  if (state.flash) messageSlot.append(flashNotice(state.flash));

  const usersBody =
    data.users.length === 0
      ? emptyState("No users yet.")
      : table(
          ["Username", "Name", "Role", "Status", ""],
          data.users.map((u) => userRow(u, data.repos, messageSlot, container))
        );

  container.replaceChildren(
    messageSlot,
    section("Users", "Create users, set their role, reset passwords, and grant repository access.", [
      usersBody,
      el("div", { class: "panel admin-only", style: "margin-top:16px" }, createUserForm(messageSlot, container))
    ])
  );
}

function userRow(u, repos, messageSlot, container) {
  const roleSelect = el("select", {}, [
    el("option", { value: "developer", text: "developer" }),
    el("option", { value: "admin", text: "admin" })
  ]);
  roleSelect.value = u.role;
  roleSelect.addEventListener("change", async () => {
    try {
      await api.updateUser(u.userId, { role: roleSelect.value });
      await renderUsers(container, { flash: `${u.username} is now ${roleSelect.value}` });
    } catch (error) {
      roleSelect.value = u.role;
      messageSlot.replaceChildren(notice("error", error.message));
    }
  });

  const reset = el("button", { class: "quiet admin-only", text: "Reset password" });
  reset.addEventListener("click", () => {
    const pw = window.prompt(`New password for ${u.username} (min 12 chars):`);
    if (!pw) return;
    api
      .updateUser(u.userId, { password: pw })
      .then(() => renderUsers(container, { flash: `Password reset for ${u.username}` }))
      .catch((error) => messageSlot.replaceChildren(notice("error", error.message)));
  });

  const reposBtn = el("button", { class: "quiet", text: u.role === "admin" ? "All repos" : "Repos" });
  if (u.role !== "admin") {
    reposBtn.addEventListener("click", () => openRepoAccess(u, repos, messageSlot, container));
  } else {
    reposBtn.disabled = true;
    reposBtn.title = "Admins access all repositories";
  }

  const del = el("button", { class: "quiet-danger admin-only", text: "Delete" });
  del.addEventListener("click", (event) => {
    confirmInline(event.target.closest("td"), async () => {
      try {
        await api.deleteUser(u.userId);
        await renderUsers(container, { flash: `${u.username} deleted` });
      } catch (error) {
        messageSlot.replaceChildren(notice("error", error.message));
      }
    });
  });

  return el("tr", {}, [
    el("td", { class: "mono", text: u.username || "(no username)" }),
    el("td", { class: "dim", text: u.name || "-" }),
    el("td", {}, roleSelect),
    el("td", { class: u.status === "active" ? "dim" : "", text: u.status }),
    el("td", { class: "actions" }, [reset, reposBtn, del])
  ]);
}

async function openRepoAccess(u, repos, messageSlot, container) {
  let data;
  try {
    data = await api.userRepos(u.userId);
  } catch (error) {
    messageSlot.replaceChildren(notice("error", error.message));
    return;
  }

  const assigned = table(
    ["Repository", "Access", ""],
    data.access.length === 0
      ? [el("tr", {}, [el("td", { class: "dim", text: "none" }), el("td", {}), el("td", {})])]
      : data.access.map((a) => {
          const remove = el("button", { class: "quiet-danger", text: "Revoke" });
          remove.addEventListener("click", async () => {
            try {
              await api.revokeUserRepo(u.userId, a.repoId);
              await openRepoAccess(u, repos, messageSlot, container);
            } catch (error) {
              messageSlot.replaceChildren(notice("error", error.message));
            }
          });
          return el("tr", {}, [
            el("td", { class: "mono", text: a.repoFullName }),
            el("td", { class: "dim", text: a.accessLevel }),
            el("td", { class: "actions" }, remove)
          ]);
        })
  );

  const repoSelect = el("select", {}, (data.repos || []).map((r) => el("option", { value: r.id, text: r.fullName })));
  const levelSelect = el("select", {}, [
    el("option", { value: "read", text: "read (view only)" }),
    el("option", { value: "actions", text: "actions (view + permitted actions)" })
  ]);
  const grant = el("button", { class: "primary", type: "submit", text: "Grant" });
  const grantForm = el("form", { class: "form-row", style: "margin-top:12px" }, [
    el("div", { class: "field" }, [el("label", { text: "Repository" }), repoSelect]),
    el("div", { class: "field" }, [el("label", { text: "Access" }), levelSelect]),
    grant
  ]);
  grantForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!repoSelect.value) return;
    try {
      await api.grantUserRepo(u.userId, { repoId: repoSelect.value, accessLevel: levelSelect.value });
      await openRepoAccess(u, repos, messageSlot, container);
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
    }
  });

  const back = el("button", { class: "quiet", text: "< Back to users" });
  back.addEventListener("click", () => renderUsers(container));

  const grantArea =
    (data.repos || []).length > 0
      ? el("div", { class: "panel", style: "margin-top:16px" }, grantForm)
      : notice(
          "info",
          "No repositories registered yet. Add one first (Bitbucket tab > add an integration, or the GitHub Repos tab), then allot it here."
        );

  container.replaceChildren(
    messageSlot,
    section(`Repository access - ${u.username}`, "Grant or revoke which repositories this developer can view and manage.", [
      assigned,
      grantArea,
      el("div", { style: "margin-top:16px" }, back)
    ])
  );
}

function createUserForm(messageSlot, container) {
  const username = el("input", { type: "text", placeholder: "username", autocomplete: "off" });
  const name = el("input", { type: "text", placeholder: "display name (optional)", autocomplete: "off" });
  const password = el("input", { type: "password", placeholder: "password (min 12 chars)", autocomplete: "new-password" });
  const role = el("select", {}, [
    el("option", { value: "developer", text: "developer" }),
    el("option", { value: "admin", text: "admin" })
  ]);
  const submit = el("button", { class: "primary", type: "submit", text: "Create user" });

  const form = el("form", {}, [
    el("div", { class: "form-row" }, [
      el("div", { class: "field" }, [el("label", { text: "Username" }), username]),
      el("div", { class: "field" }, [el("label", { text: "Name" }), name])
    ]),
    el("div", { class: "form-row", style: "margin-top:8px" }, [
      el("div", { class: "field" }, [el("label", { text: "Password" }), password]),
      el("div", { class: "field" }, [el("label", { text: "Role" }), role]),
      submit
    ])
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!username.value.trim() || password.value.length < 12) {
      messageSlot.replaceChildren(notice("error", "Username and a password of at least 12 characters are required"));
      return;
    }
    submit.disabled = true;
    submit.textContent = "creating...";
    try {
      const body = { username: username.value.trim(), password: password.value, role: role.value };
      if (name.value.trim()) body.name = name.value.trim();
      await api.createUser(body);
      await renderUsers(container, { flash: `User "${body.username}" created` });
    } catch (error) {
      messageSlot.replaceChildren(notice("error", error.message));
      submit.disabled = false;
      submit.textContent = "Create user";
    }
  });

  return form;
}
