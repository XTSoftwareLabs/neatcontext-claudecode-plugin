// Thin client for the NeatContext desktop companion API.
//
// The companion API is a loopback-only HTTP service the NeatContext desktop app
// runs while it is open. It publishes its port and a per-session token to a
// discovery file in the user's home directory. This module is the *only* place
// the plugin talks to NeatContext; it knows nothing about how NeatContext works
// internally — only this small, stable public contract:
//
//   discovery file : ~/.neatcontext/companion.json  { port, token, apiVersion }
//   GET  /v1/health                      -> { ok, app, apiVersion, appVersion }
//   GET  /v1/contexts   (Bearer token)   -> { contexts: [{ id, name }], connected }
//   PUT  /v1/connection (Bearer token)   -> body { contextId } -> { contextId, contextName }
//   DELETE /v1/connection (Bearer token) -> 204
//   GET  /v1/context    (Bearer token)   -> { contextId, contextName, document }
//
// Override the discovery file location with NEATCONTEXT_COMPANION_FILE.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const NOT_RUNNING_MESSAGE =
  "NeatContext desktop is not running. Install the NeatContext desktop app and " +
  "open it, then try again. (The plugin talks to NeatContext over a local-only " +
  "connection while the app is open.)";

export function discoveryFilePath() {
  const override = process.env.NEATCONTEXT_COMPANION_FILE;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(homedir(), ".neatcontext", "companion.json");
}

export async function readDiscovery() {
  try {
    const raw = await readFile(discoveryFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.port === "number" && typeof parsed?.token === "string") {
      return { port: parsed.port, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export async function request(discovery, method, route, { body, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}${route}`, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return {
      status: response.status,
      json: text.length > 0 ? JSON.parse(text) : undefined
    };
  } finally {
    clearTimeout(timer);
  }
}

// Returns a live connection handle, or null when NeatContext is not reachable.
export async function connect({ timeoutMs = 4000 } = {}) {
  const discovery = await readDiscovery();
  if (!discovery) {
    return null;
  }
  try {
    const health = await request(discovery, "GET", "/v1/health", { timeoutMs });
    if (health.status !== 200 || health.json?.ok !== true) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    listContexts: () => request(discovery, "GET", "/v1/contexts"),
    selectContext: (contextId) =>
      request(discovery, "PUT", "/v1/connection", { body: { contextId } }),
    disconnect: () => request(discovery, "DELETE", "/v1/connection"),
    getDocument: (opts) => request(discovery, "GET", "/v1/context", opts)
  };
}
