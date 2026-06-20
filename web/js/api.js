const KEY_STORAGE = "hubolt.apiKey";

export class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

export function getStoredKey() {
  return window.localStorage.getItem(KEY_STORAGE);
}

export function storeKey(key) {
  window.localStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  window.localStorage.removeItem(KEY_STORAGE);
}

async function request(path, options = {}) {
  const key = getStoredKey();
  const headers = { ...(options.headers || {}) };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new ApiError("Server unreachable", 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Some endpoints (or proxies) may return empty bodies.
  }

  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message || payload.reason)) ||
      `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return payload;
}

export const api = {
  health: () => request("/health"),
  org: () => request("/orgs/current"),

  reviews: (params = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    if (params.repo) query.set("repo", params.repo);
    const suffix = query.toString() ? `?${query}` : "";
    return request(`/history/reviews${suffix}`);
  },
  review: (id) => request(`/history/reviews/${encodeURIComponent(id)}`),

  budgets: () => request("/budgets"),
  createBudget: (body) => request("/budgets", { method: "POST", body }),
  updateBudget: (provider, body) =>
    request(`/budgets/${encodeURIComponent(provider)}`, { method: "PATCH", body }),
  deleteBudget: (provider) =>
    request(`/budgets/${encodeURIComponent(provider)}`, { method: "DELETE" }),

  auditEvents: (params = {}) => {
    const query = new URLSearchParams({ format: "json" });
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    if (params.action) query.set("action", params.action);
    return request(`/audit/export?${query}`);
  },

  gatewayStatus: () => request("/gateway/status"),
  gatewayModels: () => request("/gateway/models"),
  configureCredential: (provider, apiKey) =>
    request("/gateway/credentials", { method: "POST", body: { provider, apiKey } }),
  removeCredential: (provider) =>
    request(`/gateway/credentials/${encodeURIComponent(provider)}`, { method: "DELETE" }),

  repos: () => request("/github-repos"),
  createRepo: (body) => request("/github-repos", { method: "POST", body }),
  deleteRepo: (fullName) => {
    const [owner, repo] = fullName.split("/");
    return request(`/github-repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: "DELETE" });
  },
  reviewModel: () => request("/github-repos/review-model"),
  setReviewModel: (body) => request("/github-repos/review-model", { method: "PUT", body }),
  reviewStatus: () => request("/github-repos/status")
};
