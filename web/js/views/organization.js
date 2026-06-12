import { api } from "../api.js";
import { el, table, section, emptyState, formatDate } from "../dom.js";

export async function renderOrganization(container) {
  const org = await api.org();

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
          ["Name", "Email", "Role"],
          org.members.map((member) =>
            el("tr", {}, [
              el("td", { text: member.name || "-" }),
              el("td", { class: "dim", text: member.email }),
              el("td", { class: "dim", text: member.role })
            ])
          )
        );

  const keysBody =
    org.apiKeys.length === 0
      ? emptyState("No API keys.")
      : table(
          ["Name", "Created", "Last used", "Expires"],
          org.apiKeys.map((key) =>
            el("tr", {}, [
              el("td", { text: key.name }),
              el("td", { class: "dim", text: formatDate(key.createdAt) }),
              el("td", { class: "dim", text: key.lastUsedAt ? formatDate(key.lastUsedAt) : "never" }),
              el("td", { class: "dim", text: key.expiresAt ? formatDate(key.expiresAt) : "never" })
            ])
          )
        );

  container.replaceChildren(
    section("Details", null, info),
    section("Members", null, membersBody),
    section("API keys", "Key values are never stored or displayed; only metadata.", keysBody)
  );
}
