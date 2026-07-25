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
//   GET  /v1/connection (Bearer token)   -> { connected, version }
//   PUT  /v1/connection (Bearer token)   -> body { contextId } -> { contextId, contextName }
//   DELETE /v1/connection (Bearer token) -> 204
//   GET  /v1/context    (Bearer token)   -> { contextId, contextName, document }
//
// Override the discovery file location with NEATCONTEXT_COMPANION_FILE.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// NeatContext holds the connected context in memory for as long as the app is
// open, so quitting or restarting it drops the connection. The plugin records
// the selection here so it can put the connection back instead of leaving a
// running session silently ungrounded. Lives beside the discovery file, which
// keeps NEATCONTEXT_COMPANION_FILE a single override for both.
export function selectionFilePath() {
  return path.join(path.dirname(discoveryFilePath()), "plugin-selection.json");
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

export async function readSelection() {
  try {
    const parsed = JSON.parse(await readFile(selectionFilePath(), "utf8"));
    if (typeof parsed?.contextId === "string" && parsed.contextId.trim().length > 0) {
      return {
        contextId: parsed.contextId,
        contextName:
          typeof parsed.contextName === "string" ? parsed.contextName : parsed.contextId
      };
    }
    return null;
  } catch {
    // Missing or half-written: the plugin simply has nothing to restore.
    return null;
  }
}

export async function writeSelection(selection) {
  const file = selectionFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(selection, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function clearSelection() {
  await rm(selectionFilePath(), { force: true }).catch(() => undefined);
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

// The routes, bound to one discovery snapshot. Callers that must survive a
// NeatContext restart (which changes both port and token) rebuild this from a
// fresh `readDiscovery()` rather than holding on to a handle.
export function clientFor(discovery) {
  return {
    listContexts: () => request(discovery, "GET", "/v1/contexts"),
    getConnection: () => request(discovery, "GET", "/v1/connection"),
    selectContext: (contextId) =>
      request(discovery, "PUT", "/v1/connection", { body: { contextId } }),
    disconnect: () => request(discovery, "DELETE", "/v1/connection"),
    getDocument: (opts) => request(discovery, "GET", "/v1/context", opts)
  };
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
  return clientFor(discovery);
}

// Reports what NeatContext currently has connected, putting the remembered
// selection back first if the app has forgotten it. Without this, restarting
// NeatContext leaves an open session with a tool list from its old context but
// a `get_context` that answers "no context is connected" — the session looks
// grounded and is not. Throws only when NeatContext is unreachable.
export async function ensureConnection(client) {
  const current = await client.getConnection();
  if (current.status !== 200) {
    return null;
  }
  const version = current.json?.version ?? null;
  const connected = current.json?.connected ?? null;
  if (connected) {
    return { connected, version, restored: false };
  }

  const remembered = await readSelection();
  if (!remembered) {
    return { connected: null, version, restored: false };
  }

  const restored = await client.selectContext(remembered.contextId);
  if (restored.status !== 200) {
    // The context was deleted or renamed in NeatContext: stop trying to bring
    // back something that no longer exists.
    await clearSelection();
    return { connected: null, version, restored: false, restoreFailed: true };
  }
  const after = await client.getConnection();
  return {
    connected: {
      contextId: remembered.contextId,
      contextName: restored.json?.contextName ?? remembered.contextName
    },
    version: after.status === 200 ? (after.json?.version ?? version) : version,
    restored: true
  };
}
