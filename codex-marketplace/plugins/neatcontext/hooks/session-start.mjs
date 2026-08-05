// Re-inject the small routing menu at startup, resume, clear, and compaction.
// Profiles and knowledge are deliberately not injected here; get_context loads
// only the selected context after routing has chosen it.
//
// This hook is also the only moment anything in the plugin learns that `/new`
// happened. Codex starts a new thread inside the same process and does not
// restart the MCP server, so the bridge's `CODEX_THREAD_ID` still names the
// thread that just ended. The id delivered on stdin here is the current one,
// so it is recorded for the long-lived bridge to re-read — see
// src/core/host-session.mjs.

import { readSelection } from "../src/core/local-state.mjs";
import { configureSessionId } from "../src/core/session.mjs";
import { pruneHostPointers, writeHostPointer } from "../src/core/host-session.mjs";
import {
  menuEntries,
  readRouting,
  renderMenu,
  resolveMode
} from "../src/core/routing.mjs";
import { listAllContexts } from "../src/core/selection.mjs";

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

const input = await readInput();
const threadId =
  typeof input.session_id === "string" && input.session_id.trim().length > 0
    ? input.session_id.trim()
    : process.env.CODEX_THREAD_ID;

configureSessionId(() => threadId);

// Tell the long-lived bridge which thread this host process is on now. Silent
// on failure: recording this must never delay or break the start of a thread.
// Startup is also the natural moment to sweep pointers whose host is gone.
await writeHostPointer(threadId, { source: "session-start" }).catch(() => undefined);
await pruneHostPointers().catch(() => undefined);

const [{ contexts }, state, selection] = await Promise.all([
  listAllContexts(),
  readRouting(),
  readSelection().catch(() => null)
]);
const mode = resolveMode(state, threadId);
const selected = selection?.available === false ? null : selection;
const menu = renderMenu(menuEntries(contexts, state), {
  connectedId: selected?.contextId ?? null,
  mode
});

const groundingGuidance = selected
  ? `The "${selected.contextName}" context is selected for this thread. For a request in its scope, call \`get_context\` only if its result is not already present since the latest context switch or compaction; otherwise reuse the existing result. Do not call \`get_context\` merely to check connection status.`
  : contexts.length > 0
    ? "No NeatContext context is selected for this thread. Do not call `get_context` to check connection status. Follow the routing menu, and load grounding only after `use_context` succeeds."
    : "No NeatContext contexts are currently available. Do not call `get_context`. Continue normal work without NeatContext grounding unless the user asks to create or import a context.";

const guidance = [
  "NeatContext is installed for this Codex thread.",
  groundingGuidance,
  "Connect or switch contexts inside this thread with `use_context` or the explicit `$neatcontext:use` skill. Disconnect the current context with `$neatcontext:disconnect`. There is no Desktop connection right now.",
  menu,
  "Use `$neatcontext:save` to preserve durable work from the visible conversation. Never parse Codex transcript files for that workflow."
]
  .filter(Boolean)
  .join("\n\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: guidance
    }
  })
);
