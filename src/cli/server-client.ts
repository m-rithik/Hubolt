import { loadEnv } from "../config/env.js";

/**
 * Shared connection handling for CLI commands that talk to a Hubolt server
 * (history, gateway test, audit export). Resolution order: explicit flag,
 * then HUBOLT_SERVER_URL / HUBOLT_API_KEY from the environment or .env.
 */

export interface ServerConnectionOptions {
  server?: string;
  apiKey?: string;
}

export interface ServerConnection {
  serverUrl: string;
  apiKey: string;
}

export class ServerRequestError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "ServerRequestError";
  }
}

export function resolveServerConnection(
  options: ServerConnectionOptions,
  env: NodeJS.ProcessEnv = loadProcessEnv()
): ServerConnection {
  const serverUrl = (options.server?.trim() || env.HUBOLT_SERVER_URL?.trim() || "").replace(/\/+$/, "");
  if (!serverUrl) {
    throw new Error("Missing server URL. Pass --server or set HUBOLT_SERVER_URL.");
  }

  const apiKey = options.apiKey?.trim() || env.HUBOLT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing API key. Pass --api-key or set HUBOLT_API_KEY.");
  }

  return { serverUrl, apiKey };
}

function loadProcessEnv(): NodeJS.ProcessEnv {
  loadEnv();
  return process.env;
}

export async function serverGet<T = unknown>(
  connection: ServerConnection,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${connection.apiKey}` }
    });
  } catch {
    throw new ServerRequestError(`Server unreachable at ${connection.serverUrl}`, 0);
  }

  let payload: unknown = null;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (for example a CSV export); callers using serverGetText
    // never reach here, so treat it as an error payload below.
  }

  if (!response.ok) {
    const body = payload as { error?: string; message?: string } | null;
    const message = body?.error || body?.message || `Request failed (${response.status})`;
    throw new ServerRequestError(message, response.status);
  }

  return payload as T;
}

export async function serverPost<T = unknown>(
  connection: ServerConnection,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.serverUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new ServerRequestError(`Server unreachable at ${connection.serverUrl}`, 0);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Empty body is acceptable for some endpoints.
  }

  if (!response.ok) {
    const parsed = payload as { error?: string; message?: string } | null;
    const message = parsed?.error || parsed?.message || `Request failed (${response.status})`;
    throw new ServerRequestError(message, response.status);
  }

  return payload as T;
}

/** GET returning the raw body, for non-JSON formats such as CSV exports. */
export async function serverGetText(
  connection: ServerConnection,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${connection.apiKey}` }
    });
  } catch {
    throw new ServerRequestError(`Server unreachable at ${connection.serverUrl}`, 0);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // Keep the status-based message.
    }
    throw new ServerRequestError(message, response.status);
  }

  return text;
}
