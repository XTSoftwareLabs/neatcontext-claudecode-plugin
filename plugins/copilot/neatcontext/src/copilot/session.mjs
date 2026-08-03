// GitHub Copilot host adapter for the reusable session-aware runtime.
//
// Neither Copilot host hands this process a session id the way Claude Code
// does: Copilot CLI exposes no session identity to plugin processes, and the
// VS Code Agent Plugins preview does not document one for MCP servers. What
// both hosts do give every plugin process — the CLI the slash commands spawn
// and the MCP server alike — is the workspace as its working directory.
//
// So a "session" here is the workspace: one selected context per workspace,
// shared by every Copilot session opened in it. The id is a stable digest of
// the normalized workspace path, so the CLI and the MCP server agree on it
// without ever talking to each other.
//
// NEATCONTEXT_SESSION_ID overrides the digest — for tests, and for any host
// that can inject a real per-session id into every plugin process.
//
// CLAUDE_CODE_SESSION_ID is deliberately NOT consulted, even though a
// Claude-compat host might set it: a variable only some of this plugin's
// processes see is worse than none, because the CLI and the MCP server would
// scope to different sessions and the selection would silently split. (It
// also leaks into child shells when the user launches Copilot from inside a
// Claude Code session, which would hijack the scope the same way.)

import { createHash } from "node:crypto";
import path from "node:path";
import { configureSessionId } from "../core/session.mjs";

function explicitId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function workspaceSessionId(workspace = process.cwd()) {
  const resolved = path.resolve(workspace);
  // Windows paths compare case-insensitively; two spellings of one folder must
  // not become two sessions.
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `copilot-ws-${digest}`;
}

export function copilotSessionId() {
  return explicitId(process.env.NEATCONTEXT_SESSION_ID) ?? workspaceSessionId();
}

configureSessionId(copilotSessionId);
