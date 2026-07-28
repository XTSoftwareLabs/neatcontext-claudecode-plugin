// Codex host adapter for the reusable session-aware runtime.

import { configureSessionId } from "../core/session.mjs";

export function codexThreadId() {
  return process.env.CODEX_THREAD_ID;
}

configureSessionId(codexThreadId);
