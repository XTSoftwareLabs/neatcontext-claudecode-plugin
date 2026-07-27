// Selecting a context — the one operation both halves of the plugin perform.
//
// The slash commands do it when the user names a context, and the MCP bridge
// does it when the session routes itself to one. They must agree exactly: a
// switch is "write the selection file, and leave the desktop app's connection
// consistent with it", and getting only half of that right is what leaves a
// session grounded in one context while it believes it is in another.
//
// This module exists because neither of its neighbours can own the pair.
// `companion-client.mjs` knows the app but must not learn about lite contexts —
// `lite-context.mjs` already imports it, and the dependency cannot run both
// ways.

import { clearSelection, connect, writeSelection } from "./companion-client.mjs";
import { listLite } from "./lite-context.mjs";

// Everything connectable right now, of both kinds, in the order the list
// command numbers them. `client` is null when the desktop app is not running,
// which is normal: lite contexts do not need it.
export async function listAllContexts() {
  const lite = (await listLite()).map((context) => ({ ...context, kind: "lite" }));
  const client = await connect();
  let standard = [];
  let appListed = false;
  if (client) {
    const response = await client.listContexts();
    if (response.status === 200) {
      appListed = true;
      standard = (response.json?.contexts ?? []).map((context) => ({
        ...context,
        kind: "standard"
      }));
    }
  }
  return { contexts: [...standard, ...lite], lite, standard, client, appListed };
}

// By number (as the list prints them), exact name, or unique substring. Shared
// so that a name the user types at a slash command and a name the session's
// model reads off the routing menu resolve to the same context.
export function resolveContext(contexts, query) {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) {
    const context = contexts[Number(trimmed) - 1];
    return context ? { context } : { error: "out_of_range" };
  }
  const lower = trimmed.toLowerCase();
  const exact = contexts.filter((context) => context.name.toLowerCase() === lower);
  if (exact.length === 1) {
    return { context: exact[0] };
  }
  const partial = contexts.filter((context) => context.name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { context: partial[0] };
  }
  return { error: partial.length > 1 || exact.length > 1 ? "ambiguous" : "not_found" };
}

// Makes `target` the selected context. Returns what happened rather than
// printing it, because the two callers report to different audiences: one to a
// terminal, one to a model.
export async function applySelection(target, client) {
  if (target.kind === "lite") {
    // The app must not stay bound to a standard context while a lite one is
    // selected, or the two sources disagree about what is grounded.
    if (client) {
      await client.disconnect().catch(() => undefined);
    }
    // `liteContextId`, not `contextId`: see selectionFilePath() for why a lite
    // selection has to be invisible to pre-lite plugin processes.
    await writeSelection({ kind: "lite", liteContextId: target.id, contextName: target.name });
    return { ok: true, kind: "lite", name: target.name };
  }

  if (!client) {
    return { ok: false, reason: "app-offline" };
  }
  const selection = await client.selectContext(target.id);
  if (selection.status !== 200) {
    return { ok: false, reason: "refused" };
  }
  const name = selection.json?.contextName ?? target.name;

  // Deliberately *not* also claiming the app's session-less connection. Doing
  // that made a bridge stranded on an old build usable during an upgrade, at the
  // cost of moving every other window: the session-less connection is the one a
  // stale bridge reads, so writing it re-grounds them all. An upgrade is over in
  // one restart; the isolation has to hold every day after that.

  // Remembered so the bridge can put the connection back if NeatContext is
  // restarted while this session is still open. The app is connected either
  // way, so failing to write this is not worth failing the switch over.
  const record = { kind: "standard", contextId: target.id, contextName: name };
  await writeSelection(record).catch(() => undefined);
  return { ok: true, kind: "standard", name };
}

export { clearSelection };
