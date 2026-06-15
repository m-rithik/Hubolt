import { api } from "../api.js";
import { el, table, section, severityBadge, emptyState, emptyWithCommand, timeCell, setHash, debounce, formatDate, formatUsd } from "../dom.js";

const PAGE_SIZE = 20;

function reviewsHash({ repo, offset }) {
  const query = new URLSearchParams();
  if (repo) query.set("repo", repo);
  if (offset > 0) query.set("offset", String(offset));
  const suffix = query.toString();
  return suffix ? `#/reviews?${suffix}` : "#/reviews";
}

export async function renderReviews(container, state = {}) {
  const offset = Number.parseInt(state.offset, 10) || 0;
  const repo = state.repo || "";

  const result = await api.reviews({ limit: PAGE_SIZE, offset, repo: repo || undefined });

  const filterInput = el("input", {
    type: "search",
    placeholder: "Filter by repository",
    value: repo
  });
  // Live filtering; replace history so typing does not stack entries.
  filterInput.addEventListener(
    "input",
    debounce(() => {
      setHash(reviewsHash({ repo: filterInput.value.trim(), offset: 0 }), { replace: true });
    }, 300)
  );

  const card = el("div", { class: "section" });
  const parts = [el("div", { class: "toolbar" }, [filterInput]), card];

  if (result.reviews.length === 0) {
    card.append(
      repo
        ? emptyState("no reviews match this filter")
        : emptyWithCommand(
            "no reviews ingested yet - push one from any repo:",
            "hubolt review --staged --json review.json && hubolt push-report --report review.json"
          )
    );
  } else {
    card.append(
      table(
        ["Repository", "Provider", "Model", { label: "Findings", numeric: true }, "Created"],
        result.reviews.map((review) =>
          el("tr", { class: "clickable", onclick: () => { window.location.hash = `#/reviews/${review.id}`; } }, [
            el("td", {}, el("a", { class: "cell-link", href: `#/reviews/${review.id}`, text: review.repository })),
            el("td", { class: "dim", text: review.provider }),
            el("td", { class: "mono dim", text: review.model }),
            el("td", { class: "num", text: String(review.findingCount) }),
            timeCell(review.createdAt)
          ])
        )
      )
    );

    const { total } = result.pagination;
    const from = offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    const prev = el("button", { text: "Previous" });
    const next = el("button", { text: "Next" });
    prev.disabled = offset === 0;
    next.disabled = to >= total;
    prev.addEventListener("click", () =>
      setHash(reviewsHash({ repo, offset: Math.max(0, offset - PAGE_SIZE) }))
    );
    next.addEventListener("click", () => setHash(reviewsHash({ repo, offset: offset + PAGE_SIZE })));

    card.append(el("div", { class: "pager" }, [`${from}-${to} of ${total}`, prev, next]));
  }

  container.replaceChildren(...parts);

  // Re-focus the filter when the rerender came from typing in it.
  if (repo && document.activeElement === document.body) {
    const end = filterInput.value.length;
    filterInput.focus();
    filterInput.setSelectionRange(end, end);
  }
}

export async function renderReviewDetail(container, id, backHref = "#/reviews") {
  const review = await api.review(id);

  const head = el("div", { class: "detail-head" }, [
    el("a", { class: "back", href: backHref, text: "Back to reviews" })
  ]);

  const summary = el("dl", { class: "kv" }, [
    kv("Repository", review.repository),
    kv("Scope", review.scope),
    kv("Provider", review.provider),
    kv("Model", review.model, "mono"),
    kv("Created", formatDate(review.createdAt)),
    review.summary ? kv("Summary", review.summary) : null
  ].flat().filter(Boolean));

  const findingsBody =
    review.findings.length === 0
      ? emptyState("No findings recorded for this review.")
      : table(
          ["Severity", "Rule", "Location", "Message", { label: "Confidence", numeric: true }],
          review.findings.map((finding) =>
            el("tr", {}, [
              el("td", {}, severityBadge(finding.severity)),
              el("td", { class: "mono dim", text: finding.ruleId }),
              el("td", { class: "mono dim", text: `${finding.file}:${finding.lineStart}` }),
              el("td", { text: finding.message }),
              el("td", { class: "num dim", text: finding.confidence.toFixed(2) })
            ])
          )
        );

  const blocks = [
    head,
    section("Review", null, summary),
    section(`Findings (${review.findings.length})`, null, findingsBody)
  ];

  if (review.analyzerSignals.length > 0) {
    blocks.push(
      section(`Analyzer signals (${review.analyzerSignals.length})`, null,
        table(
          ["Severity", "Analyzer", "Rule", "Location", "Message"],
          review.analyzerSignals.map((signal) =>
            el("tr", {}, [
              el("td", {}, severityBadge(signal.severity)),
              el("td", { class: "dim", text: signal.analyzer }),
              el("td", { class: "mono dim", text: signal.ruleId }),
              el("td", { class: "mono dim", text: `${signal.file}:${signal.lineStart}` }),
              el("td", { text: signal.message })
            ])
          )
        )
      )
    );
  }

  if (review.modelUsage.length > 0) {
    blocks.push(
      section("Model usage", null,
        table(
          ["Provider", "Model", { label: "Input tokens", numeric: true }, { label: "Output tokens", numeric: true }, { label: "Cost", numeric: true }],
          review.modelUsage.map((usage) =>
            el("tr", {}, [
              el("td", { class: "dim", text: usage.provider }),
              el("td", { class: "mono dim", text: usage.model }),
              el("td", { class: "num", text: String(usage.inputTokens) }),
              el("td", { class: "num", text: String(usage.outputTokens) }),
              el("td", { class: "num", text: formatUsd(usage.estimatedCostUsd) })
            ])
          )
        )
      )
    );
  }

  container.replaceChildren(...blocks);
}

function kv(label, value, valueClass) {
  return [
    el("dt", { text: label }),
    el("dd", { class: valueClass, text: value })
  ];
}
