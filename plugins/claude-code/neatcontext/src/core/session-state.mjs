// Per-session state the plugin keeps between processes, in
// `plugin-routing.json` under `sessions[id].save`.
//
// This used to back an automatic save nudge, which watched a session for signs
// that work was worth preserving and proposed saving it. That is gone: saving
// is user-initiated, through `/neatcontext:save`, and nothing here decides when.
//
// What remains is one fact a slash command cannot obtain for itself. Claude
// hands the transcript location to hooks and to nobody else, so the hooks
// record it here and `/neatcontext:save` reads it back when it compiles its
// ephemeral, privacy-filtered evidence view. No transcript content is stored —
// only the path Claude supplied.

export function emptySaveState() {
  return { transcriptPath: null };
}

// State read back from plugin-routing.json may be missing, written by an older
// build that kept the nudge counters, or hand-broken. Whatever it is, this must
// come up in a shape callers can run on: unknown keys are dropped rather than
// preserved, so the retired counters disappear the first time a session writes.
export function normalizeSaveState(raw) {
  const clean = emptySaveState();
  if (typeof raw !== "object" || raw === null) {
    return clean;
  }
  if (typeof raw.transcriptPath === "string") {
    clean.transcriptPath = raw.transcriptPath;
  }
  return clean;
}

// Rejects anything that is not a plausible single-line path. The value arrives
// from the host on stdin and is later opened, so it is bounded and screened for
// embedded newlines and NULs before it is written anywhere.
export function rememberTranscriptPath(save, value) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 32_768 ||
    candidate.includes("\0") ||
    candidate.includes("\r") ||
    candidate.includes("\n")
  ) {
    return false;
  }
  save.transcriptPath = candidate;
  return true;
}
