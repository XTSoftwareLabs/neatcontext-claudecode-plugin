// Stop hook: once per assistant turn, ask "is this a moment worth proposing a
// save?" — and when it is, block the stop so the session's model can decide
// whether there is actually anything durable to offer.
//
// This process has no model (see save-nudge.mjs). It updates counters from the
// transcript delta under the whitelist stated in PRIVACY.md, runs the pure
// gate, and either exits quietly or prints {"decision": "block", "reason"} for
// the host. The nudge is an enhancement: any failure here must end in a silent
// exit 0, never in a turn that cannot stop.

import { open, stat } from "node:fs/promises";
import { configureSessionId } from "../src/core/session.mjs";
import { readSelection } from "../src/core/companion-client.mjs";
import { readRouting, resolveMode, updateRouting } from "../src/core/routing.mjs";
import {
  evaluateSaveNudge,
  ingestTranscriptText,
  normalizeSaveState,
  proposalInstruction
} from "../src/core/save-nudge.mjs";

// Reading the delta caps at this many bytes: a first run against a transcript
// that is already huge skips ahead rather than parsing megabytes on the hook's
// clock.
const MAX_DELTA_BYTES = 8 * 1024 * 1024;

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return JSON.parse(raw);
}

// New complete lines since `offset`. The offset only ever advances past a
// final newline, so a line the host is mid-write on is re-read next turn.
async function readDelta(file, offset) {
  const info = await stat(file);
  // A smaller file than last time is a different file — a resumed session or
  // a rotated transcript. Counting is best restarted, not continued.
  let from = info.size < offset ? 0 : offset;
  if (info.size - from > MAX_DELTA_BYTES) {
    from = info.size - MAX_DELTA_BYTES;
  }
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(info.size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      return { text: "", offset: from, size: info.size };
    }
    return {
      text: buffer.subarray(0, lastNewline + 1).toString("utf8"),
      offset: from + lastNewline + 1,
      size: info.size
    };
  } finally {
    await handle.close();
  }
}

async function main() {
  const input = await readStdin();
  // The guard the host provides against a block loop: a continuation this hook
  // already forced must always be allowed to stop.
  if (input.stop_hook_active) return;
  const id = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : null;
  if (!id) return;
  configureSessionId(() => id);

  const routing = await readRouting();
  const mode = resolveMode(routing, id);
  const save = normalizeSaveState(routing.sessions[id]?.save);
  save.turns += 1;

  // The update-merge signal needs to know what "since it was connected" means.
  const selection = await readSelection().catch(() => null);
  const liteConnectedName = selection?.kind === "lite" ? selection.contextName : null;
  const connectedId = selection?.kind === "lite" ? selection.contextId : null;
  if (connectedId !== save.connectedId) {
    save.connectedId = connectedId;
    save.writesAtConnect = save.writes;
  }

  let markerSeen = false;
  if (typeof input.transcript_path === "string" && input.transcript_path.length > 0) {
    try {
      const delta = await readDelta(input.transcript_path, save.transcriptOffset);
      markerSeen = ingestTranscriptText(save, delta.text);
      save.transcriptOffset = delta.offset;
      save.transcriptBytes = delta.size;
    } catch {
      // No transcript is no signal, not an error: turn counting still works.
    }
  }

  const outcomes = [];
  // A fire from last turn resolves now: the marker in the delta means the user
  // saw a proposal — the session's one visible ask is spent. No marker means
  // the model judged there was nothing durable; that silence re-arms the gate
  // and is exactly the calibration evidence the thresholds are waiting for.
  if (save.awaitingMarker) {
    save.awaitingMarker = false;
    if (markerSeen) {
      save.proposalVisible = true;
      save.proposedAt = new Date().toISOString();
      outcomes.push({ kind: "save-nudge", outcome: "proposed" });
    } else {
      outcomes.push({ kind: "save-nudge", outcome: "silent" });
    }
  }

  const verdict = evaluateSaveNudge(save, { mode, liteConnectedName });
  if (verdict.fire) {
    save.fires += 1;
    save.writesAtFire = save.writes;
    save.awaitingMarker = true;
    // Completion beats are spent by the fire they earned: "just landed" is
    // only true once, and a re-fire has to be earned by something new.
    save.commitLanded = false;
    save.redGreen = false;
    outcomes.push({ kind: "save-nudge", outcome: "fired", tier: verdict.tier, reasons: verdict.reasons });
  }
  // Armed for one evaluation only: a compaction from hours ago must not read
  // as "just compacted" on some later turn.
  save.compactPending = false;

  await updateRouting((state) => {
    state.sessions[id] = { ...state.sessions[id], save, updatedAt: new Date().toISOString() };
    for (const outcome of outcomes) {
      state.decisions.push({ at: new Date().toISOString(), sessionShort: id.slice(0, 8), ...outcome });
    }
  });

  if (verdict.fire) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: proposalInstruction({ reasons: verdict.reasons, liteConnectedName })
      })
    );
  }
}

// A truthful exit either way: exit 0 with no output is "nothing to propose",
// and a crash must look the same — the nudge never gets to break stopping.
// No process.exit(): it can truncate a stdout write still in flight.
main().catch(() => undefined);
