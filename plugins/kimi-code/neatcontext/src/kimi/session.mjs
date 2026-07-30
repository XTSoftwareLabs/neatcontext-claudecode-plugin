// Kimi Code host adapter for the reusable session-aware runtime.
//
// Kimi expands ${KIMI_SESSION_ID} inside plugin Skills, but it deliberately
// does not expose that value as an MCP process environment variable. Skills
// pass the id to the CLI, while the MCP bridge binds its per-session process
// through the bind_session tool before exposing context-dependent tools.

import { configureSessionId } from "../core/session.mjs";

const UNBOUND_SESSION_ID = `kimi-unbound-${process.pid}`;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

let boundSessionId = null;

export function normalizeKimiSessionId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.trim();
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    !SAFE_SESSION_ID.test(id)
  ) {
    return null;
  }
  return id;
}

export function bindKimiSessionId(value) {
  const id = normalizeKimiSessionId(value);
  if (!id) {
    throw new TypeError("Kimi Code supplied an invalid session id.");
  }
  if (boundSessionId && boundSessionId !== id) {
    throw new Error("This NeatContext bridge is already bound to another Kimi Code session.");
  }
  boundSessionId = id;
  return id;
}

export function kimiSessionId() {
  return boundSessionId ?? UNBOUND_SESSION_ID;
}

export function isKimiSessionBound() {
  return boundSessionId !== null;
}

configureSessionId(kimiSessionId);
