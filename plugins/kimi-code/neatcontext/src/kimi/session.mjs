// Kimi Code host adapter for the reusable session-aware runtime.
//
// Kimi expands ${KIMI_SESSION_ID} inside plugin Skills, but it deliberately
// does not expose that value as an MCP process environment variable. Skills
// pass the id to the CLI, while the MCP bridge binds its per-session process
// through the bind_session tool before exposing context-dependent tools.
//
// The binding is deliberately re-assignable. The bridge process outlives the
// session it was first bound in — a new session in the same window keeps the
// same MCP server — and each new session's skill expansion carries the new id.
// Refusing the rebind used to leave the bridge stuck on the session that ended,
// loudly erroring until Kimi restarted; accepting it re-grounds the bridge in
// the session that is actually asking. A session change must not inherit the
// previous session's context, which per-session selection files already ensure.

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

// Returns what changed, so the caller can tell a fresh bind ({ id, rebound:
// false }) from a session change ({ id, rebound: true }) and refresh what
// depends on it. An invalid id still throws: reverting to the unbound id would
// silently strip the grounding of whatever session is active.
export function bindKimiSessionId(value) {
  const id = normalizeKimiSessionId(value);
  if (!id) {
    throw new TypeError("Kimi Code supplied an invalid session id.");
  }
  const rebound = boundSessionId !== null && boundSessionId !== id;
  boundSessionId = id;
  return { id, rebound };
}

export function kimiSessionId() {
  return boundSessionId ?? UNBOUND_SESSION_ID;
}

export function isKimiSessionBound() {
  return boundSessionId !== null;
}

configureSessionId(kimiSessionId);
