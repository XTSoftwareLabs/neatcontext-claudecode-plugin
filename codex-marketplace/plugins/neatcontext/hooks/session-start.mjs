// Re-inject the small routing menu at startup, resume, clear, and compaction.
// Profiles and knowledge are deliberately not injected here; get_context loads
// only the selected context after routing has chosen it.

import { readSelection } from "../src/core/companion-client.mjs";
import { configureSessionId } from "../src/core/session.mjs";
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

const [{ contexts }, state, selection] = await Promise.all([
  listAllContexts(),
  readRouting(),
  readSelection().catch(() => null)
]);
const mode = resolveMode(state, threadId);
const menu = renderMenu(menuEntries(contexts, state), {
  connectedId: selection?.contextId ?? null,
  mode
});

const guidance = [
  "NeatContext is installed for this Codex thread.",
  "For requests that depend on the user's domain, documents, tools, or team conventions, call `get_context` before answering and ground the answer in what it returns.",
  "Connect or switch contexts inside this thread with `use_context` or the explicit `$neatcontext:use` skill. Disconnect the current context with `$neatcontext:disconnect`. Do not tell the user to select a context in the desktop app.",
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
