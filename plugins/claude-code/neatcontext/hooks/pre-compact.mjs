// PreCompact hook: record where Claude keeps this session's transcript.
//
// It used to arm the save nudge, so the turn after a compaction would weigh
// proposing a save while detail was still fresh. That nudge is gone and this
// keeps only the bookkeeping half, for the same reason stop.mjs does: the
// transcript location reaches hooks and no other plugin process, and
// `/neatcontext:save` needs it.
//
// Registered on PreCompact as well as Stop because compaction is exactly when
// a session's transcript matters most and Stop may not have run yet. Like
// stop.mjs, it writes nothing to stdout and can never delay or fail a
// compaction.

import { configureSessionId } from "../src/core/session.mjs";
import { updateRouting } from "../src/core/routing.mjs";
import { normalizeSaveState, rememberTranscriptPath } from "../src/core/session-state.mjs";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const input = JSON.parse(raw);
  const id =
    typeof input.session_id === "string" && input.session_id.trim()
      ? input.session_id.trim()
      : null;
  if (!id) return;
  configureSessionId(() => id);

  const save = normalizeSaveState({});
  if (!rememberTranscriptPath(save, input.transcript_path)) return;

  await updateRouting((state) => {
    if (normalizeSaveState(state.sessions[id]?.save).transcriptPath === save.transcriptPath) {
      return;
    }
    state.sessions[id] = {
      ...state.sessions[id],
      save,
      updatedAt: new Date().toISOString()
    };
  });
}

main().catch(() => undefined);
