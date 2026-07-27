// Claude Code host adapter for the reusable session-aware runtime.

import { configureSessionId } from "../core/session.mjs";

export function claudeSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID;
}

configureSessionId(claudeSessionId);
