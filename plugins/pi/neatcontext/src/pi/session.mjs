// Pi host adapter for the reusable session-aware runtime.
//
// Pi is the first host where the plugin runs *inside* the agent process rather
// than beside it. There is no MCP server to spawn and no environment variable to
// read: `ctx.sessionManager.getSessionId()` is right there, so the extension
// binds it directly and every core module that calls `sessionId()` — selection
// files, routing modes, declined-this-session records — isolates itself per pi
// session for free.
//
// The binding is deliberately re-assignable. `session_start` fires again on
// `/new`, `/resume`, `/fork` and reload, and each of those is a different
// session that must not inherit the previous one's context.

import { configureSessionId } from "../core/session.mjs";

// Pi's own rule for a session id (assertValidSessionId in its session manager),
// restated here because this file is what feeds it into path joins.
const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;

// Before the first session_start — and in any pi mode that turns out not to
// expose a session — the plugin still has to read and write *something*. A
// per-process id keeps that scratch state out of the way of every real session
// instead of letting it land on the shared, session-less selection file.
const UNBOUND_SESSION_ID = `pi-unbound-${process.pid}`;

let boundSessionId = null;

export function normalizePiSessionId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const id = value.trim();
  return SAFE_SESSION_ID.test(id) ? id : null;
}

// Returns the id actually bound, so a caller can log what it got rather than
// what it offered. An unusable id leaves the previous binding alone: pi has
// already told us the session changed, and reverting to the unbound id would
// silently strip the grounding of whatever session is now active.
export function bindPiSessionId(value) {
  const id = normalizePiSessionId(value);
  if (!id) {
    return null;
  }
  boundSessionId = id;
  return id;
}

export function piSessionId() {
  return boundSessionId ?? UNBOUND_SESSION_ID;
}

export function isPiSessionBound() {
  return boundSessionId !== null;
}

configureSessionId(piSessionId);
