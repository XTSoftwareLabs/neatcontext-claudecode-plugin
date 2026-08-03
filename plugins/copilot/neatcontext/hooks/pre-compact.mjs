// PreCompact hook: arm the save nudge for the turn after compaction.
//
// PreCompact cannot ask anyone anything — it fires mid-flight, with no pause
// to speak into. All it does is set one flag, so the next Stop knows that
// detail just got summarized away and a save is worth weighing while the rest
// is still fresh. The flag is consumed after one evaluation (see stop.mjs).

import { configureSessionId } from "../src/core/session.mjs";
import { updateRouting } from "../src/core/routing.mjs";
import { normalizeSaveState, rememberTranscriptPath } from "../src/core/save-nudge.mjs";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const input = JSON.parse(raw);
  const id = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : null;
  if (!id) return;
  configureSessionId(() => id);

  await updateRouting((state) => {
    const save = normalizeSaveState(state.sessions[id]?.save);
    rememberTranscriptPath(save, input.transcript_path);
    save.compactPending = true;
    state.sessions[id] = { ...state.sessions[id], save, updatedAt: new Date().toISOString() };
  });
}

// Same contract as stop.mjs: the nudge is an enhancement, and compaction must
// never be delayed or failed by it.
main().catch(() => undefined);
