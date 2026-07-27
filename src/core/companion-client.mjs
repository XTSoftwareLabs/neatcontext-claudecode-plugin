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

import { copyFile as copyFileRaw, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sessionId } from "./session.mjs";

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
//
// For a lite context (kind: "lite") this file is not a recovery record but the
// authority: there is no app holding that connection in memory.
//
// A lite selection deliberately carries its id in `liteContextId`, NOT in
// `contextId`. Plugin updates land while sessions are still running, so an
// older bridge process — holding the pre-lite code in memory — can outlive the
// update. That code reads every `contextId` as a NeatContext context, fails to
// restore a lite one, and treats the failure as "deleted upstream" by erasing
// the file. Leaving `contextId` absent makes a lite selection invisible to it:
// it reads no selection, and so has nothing to erase.
export function selectionFilePath() {
  return path.join(path.dirname(discoveryFilePath()), "plugin-selection.json");
}

// One file per host session. A session is where a context belongs: you
// open one to work on a thing, and the context is what that thing is. Sharing a
// single selection meant connecting in one window silently re-grounded every
// other, which is invisible from inside them.
//
// The global file above stays the *default* — what a window with no selection
// of its own starts on — so restarting the host still picks up the context
// you were last using, and a pre-session plugin process still finds what it
// expects to find.
export function sessionSelectionFilePath(id) {
  return path.join(path.dirname(discoveryFilePath()), "plugin-sessions", `${id}.json`);
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

// This session's selection: its own if it has one, otherwise the default —
// which it then *keeps*.
//
// Inheriting the default on every read instead of once is what made a switch in
// one window move another. A window that has never run /neatcontext:use has no
// file of its own, so it re-read the shared default each time; the moment any
// other window connected something, that default changed underneath it and it
// silently followed. Two windows, and only one of them ever chose anything.
//
// Snapshotting the default into this session's own file on first read fixes it
// without giving up the thing the default is for: a new session still starts on
// the context you were last using, so restarting the host picks up where you
// left off. It just stops tracking that value afterwards.
export async function readSelection() {
  const id = sessionId();
  if (!id) {
    return readSelectionFrom(selectionFilePath());
  }
  const own = await readSelectionFrom(sessionSelectionFilePath(id));
  if (own) {
    return own;
  }
  const inherited = await readSelectionFrom(selectionFilePath());
  if (inherited) {
    // Copied verbatim rather than re-serialized from the parsed form, which
    // would turn a lite selection's `liteContextId` into a plain `contextId` —
    // the one field shape `selectionFilePath` explains must stay as written.
    // Best-effort: grounding must not fail because a snapshot could not be
    // written, and an unpinned session still reads the right context today.
    await copyFile(selectionFilePath(), sessionSelectionFilePath(id));
  }
  return inherited;
}

async function readSelectionFrom(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    // `contextId` is also accepted for a lite kind so a selection written by an
    // earlier build of this feature still resolves.
    const liteId =
      typeof parsed?.liteContextId === "string"
        ? parsed.liteContextId
        : parsed?.kind === "lite" && typeof parsed?.contextId === "string"
          ? parsed.contextId
          : null;
    if (liteId !== null && liteId.trim().length > 0) {
      return {
        kind: "lite",
        contextId: liteId,
        contextName: typeof parsed.contextName === "string" ? parsed.contextName : liteId
      };
    }
    if (typeof parsed?.contextId === "string" && parsed.contextId.trim().length > 0) {
      // Selections written before lite contexts existed have no kind, and every
      // one of them is a NeatContext context.
      return {
        kind: "standard",
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

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function copyFile(from, to) {
  try {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFileRaw(from, to);
  } catch {
    // Nothing to pin, or nowhere to pin it: the caller already has the value.
  }
}

// Written to both places: this session's file is what it will read back, and
// the default is updated so the *next* window starts where this one left off.
export async function writeSelection(selection) {
  const id = sessionId();
  if (id) {
    await writeJson(sessionSelectionFilePath(id), selection);
  }
  await writeJson(selectionFilePath(), selection);
}

// Only ever called for a context that no longer exists, which is gone for every
// window: clearing this session's file alone would leave the default behind for
// the next one to inherit.
export async function clearSelection() {
  const id = sessionId();
  if (id) {
    await rm(sessionSelectionFilePath(id), { force: true }).catch(() => undefined);
  }
  await rm(selectionFilePath(), { force: true }).catch(() => undefined);
}

export async function request(discovery, method, route, { body, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const id = sessionId();
    const response = await fetch(`http://127.0.0.1:${discovery.port}${route}`, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        // Tells NeatContext whose connection this is about. A build of the app
        // that predates it ignores the header and serves the one shared
        // connection, which is what this plugin used to rely on anyway.
        ...(id ? { "x-neatcontext-session": id } : {}),
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

  // A lite selection is served locally and is not a NeatContext context: asking
  // the app to connect that id would 404 and, worse, make the failure path below
  // discard a perfectly good selection.
  const remembered = await readSelection();
  if (!remembered || remembered.kind !== "standard") {
    return { connected: null, version, restored: false };
  }

  const restored = await client.selectContext(remembered.contextId);
  if (restored.status !== 200) {
    // The context was deleted or renamed in NeatContext: stop trying to bring
    // back something that no longer exists — in this session or any other.
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
