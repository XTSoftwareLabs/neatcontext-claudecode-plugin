// Save nudge: deciding *when* a save is worth proposing.
//
// No process in this plugin has a model, so none of them can tell whether a
// conversation produced durable knowledge. What a hook process *can* see is
// shape: files were edited, a commit landed, a failing test went green, the
// window is filling up. This module turns that shape into a single yes/no —
// "is this a moment worth interrupting for?" — and the session's own model
// makes the real call: whether there is anything durable, and what three
// concrete things it would name. The same two-layer split as routing
// (see routing.mjs), for the same reason.
//
// The counters here are fed from the host transcript, under a strict
// whitelist: tool names, result success/failure, the first two words of shell
// commands, 16-hex hashes of edited file paths, token counts, and the presence
// of the fixed proposal marker. Nothing else survives the tick that read it —
// no message text, no command arguments, no paths. PRIVACY.md states the same
// list to the user.
//
// Every number in SAVE_NUDGE is a guess awaiting calibration. Fires and their
// outcomes are appended to the routing decisions log, which is the only
// evidence that will ever say whether these thresholds are right.

import { hashSource, updateRouting } from "./routing.mjs";

export const SAVE_NUDGE = {
  // Context-fill proxy, from transcript usage fields. Uncalibrated: the real
  // compaction point varies by model window.
  contextTokens: 150_000,
  // Fallback when a transcript carries no usage fields. Bytes are a cruder
  // proxy still.
  transcriptBytes: 350 * 1024,
  // The update-merge case: a lite context is connected and work kept moving.
  connectWrites: 3,
  // Tier B: sustained work with no single completion beat.
  tierBWrites: 5,
  tierBFiles: 3,
  tierBTurns: 12,
  // A fire the model answered with silence re-arms; one the user saw does not.
  // The cap bounds how many forced continuations a session can ever pay for.
  maxFires: 3,
  maxPathHashes: 64,
  maxPendingTools: 32
};

// The model is told to open a visible proposal with exactly this line. Its
// presence in the next turn's transcript delta is how the hook learns the
// difference between "the user saw a proposal" and "the model stayed silent" —
// a boolean, which is all that is retained.
export const PROPOSAL_MARKER = "Worth saving this session?";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Commands whose failure means work is mid-flight and whose red-then-green is
// a completion beat. Deliberately narrow: a grep or diff exiting non-zero is a
// normal answer, not a broken build, and must not disarm the nudge.
const BUILD_TOKENS = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "npx", "node", "make", "cargo", "go",
  "pytest", "jest", "vitest", "tsc", "mvn", "gradle", "dotnet"
]);

export function emptySaveState() {
  return {
    turns: 0,
    writes: 0,
    pathHashes: [],
    transcriptOffset: 0,
    transcriptBytes: 0,
    peakTokens: 0,
    commitLanded: false,
    redGreen: false,
    redTokens: [],
    buildRed: false,
    pending: {},
    compactPending: false,
    fires: 0,
    writesAtFire: 0,
    proposedAt: null,
    proposalVisible: false,
    awaitingMarker: false,
    connectedId: null,
    writesAtConnect: 0,
    lastSaveAt: null,
    writesAtSave: 0
  };
}

// State read back from plugin-routing.json may be missing, from an older
// build, or hand-broken. Whatever it is, the nudge must come up in a shape it
// can run on — losing the counters is fine, crashing the Stop hook is not.
export function normalizeSaveState(raw) {
  const clean = emptySaveState();
  if (typeof raw !== "object" || raw === null) {
    return clean;
  }
  for (const key of Object.keys(clean)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof clean[key] === "number" && typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof clean[key] === "boolean" && typeof value === "boolean") {
      clean[key] = value;
    } else if (Array.isArray(clean[key]) && Array.isArray(value)) {
      clean[key] = value.filter((item) => typeof item === "string");
    } else if (key === "pending" && typeof value === "object" && value !== null) {
      clean.pending = value;
    } else if ((key === "proposedAt" || key === "lastSaveAt" || key === "connectedId") && typeof value === "string") {
      clean[key] = value;
    }
  }
  return clean;
}

// A Bash call is routinely a compound — `git add x && git commit -m y` — and
// the commit is rarely the first segment. Each segment is a command, so each
// contributes its first words; nothing past them is read.
const commandHeads = (command) =>
  String(command ?? "")
    .split(/&&|\|\||;|\|/)
    .map((segment) => {
      const tokens = segment.trim().split(/\s+/);
      return { first: tokens[0] ?? "", second: tokens[1] ?? "", third: tokens[2] ?? "" };
    })
    .filter((head) => head.first.length > 0);

function notePending(save, id, record) {
  const keys = Object.keys(save.pending);
  if (keys.length >= SAVE_NUDGE.maxPendingTools) {
    delete save.pending[keys[0]];
  }
  save.pending[id] = record;
}

// One transcript entry, already parsed from its JSONL line. Mutates `save`,
// returns nothing — everything the entry contained beyond the whitelist is
// gone when the caller drops it.
function ingestEntry(save, entry) {
  const content = entry?.message?.content;
  if (entry?.type === "assistant") {
    const usage = entry.message?.usage;
    if (usage) {
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (Number.isFinite(total) && total > save.peakTokens) {
        save.peakTokens = total;
      }
    }
    if (!Array.isArray(content)) return false;
    let markerSeen = false;
    for (const block of content) {
      if (block?.type === "text") {
        // A boolean, checked only while a fire is unresolved. The text itself
        // is not retained.
        if (save.awaitingMarker && typeof block.text === "string" && block.text.includes(PROPOSAL_MARKER)) {
          markerSeen = true;
        }
        continue;
      }
      if (block?.type !== "tool_use") continue;
      if (WRITE_TOOLS.has(block.name)) {
        save.writes += 1;
        const file = block.input?.file_path ?? block.input?.notebook_path ?? "";
        if (file && save.pathHashes.length < SAVE_NUDGE.maxPathHashes) {
          const hash = hashSource(String(file));
          if (!save.pathHashes.includes(hash)) {
            save.pathHashes.push(hash);
          }
        }
        continue;
      }
      if (block.name === "Bash" && typeof block.id === "string") {
        const heads = commandHeads(block.input?.command);
        const tokens = [...new Set(heads.map((head) => head.first).filter((first) => BUILD_TOKENS.has(first)))];
        if (tokens.length === 0) continue;
        const commitish = heads.some(
          (head) =>
            (head.first === "git" && head.second === "commit") ||
            (head.first === "gh" && head.second === "pr" && head.third === "create")
        );
        notePending(save, block.id, { tokens, commitish });
      }
    }
    return markerSeen;
  }
  if (entry?.type === "user" && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const record = save.pending[block.tool_use_id];
      if (!record) continue;
      delete save.pending[block.tool_use_id];
      // Older state stored a single token; read both shapes.
      const tokens = Array.isArray(record.tokens) ? record.tokens : [record.token].filter(Boolean);
      if (block.is_error === true) {
        save.buildRed = true;
        for (const token of tokens) {
          if (!save.redTokens.includes(token)) {
            save.redTokens.push(token);
          }
        }
      } else {
        save.buildRed = false;
        if (tokens.some((token) => save.redTokens.includes(token))) {
          save.redGreen = true;
        }
        if (record.commitish) {
          save.commitLanded = true;
        }
      }
    }
  }
  return false;
}

// The new transcript lines since the stored offset, as raw text. Returns
// whether the fixed proposal marker appeared in them.
export function ingestTranscriptText(save, text) {
  let markerSeen = false;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (ingestEntry(save, entry)) {
      markerSeen = true;
    }
  }
  return markerSeen;
}

// The gate. Pure on purpose: every threshold and suppressor lives here, where
// a table test can reach it without a transcript, a hook, or a file.
export function evaluateSaveNudge(save, { mode, liteConnectedName = null } = {}) {
  const no = (suppressor) => ({ fire: false, tier: null, reasons: [], suppressor });

  // `manual` means the plugin never routes and never nudges (the one switch,
  // /neatcontext:mode). The rest keep the nudge quiet rather than off: no
  // proposal for a session that only read things, none while a build is red,
  // none after the user has already seen one.
  if (mode === "manual") return no("manual-mode");
  if (save.proposalVisible) return no("already-proposed");
  if (save.fires >= SAVE_NUDGE.maxFires) return no("fire-budget");
  if (save.awaitingMarker) return no("fire-unresolved");
  if (save.writes === 0) return no("no-writes");
  if (save.buildRed) return no("mid-flight");
  if (save.lastSaveAt !== null && save.writes <= save.writesAtSave) return no("nothing-since-save");
  // A silent fire re-arms the gate, but only for a session that has moved on:
  // re-firing on the identical evidence the model just judged not durable
  // would spend the whole budget saying the same thing three turns in a row.
  if (save.fires > 0 && save.writes <= save.writesAtFire) return no("nothing-since-fire");

  const reasons = [];
  const sinceConnect = save.writes - save.writesAtConnect;
  if (liteConnectedName && sinceConnect >= SAVE_NUDGE.connectWrites) {
    reasons.push(
      `work has continued on "${liteConnectedName}" — ${sinceConnect} file changes since it was connected`
    );
  }
  if (save.commitLanded) {
    reasons.push("a commit or pull request just landed");
  }
  if (save.redGreen) {
    reasons.push("a failing build or test run just went green");
  }
  if (save.compactPending) {
    reasons.push("the conversation was just compacted, and detail fades from here");
  }
  if (save.peakTokens >= SAVE_NUDGE.contextTokens || save.transcriptBytes >= SAVE_NUDGE.transcriptBytes) {
    reasons.push("the conversation is approaching auto-compaction");
  }
  if (reasons.length > 0) {
    return { fire: true, tier: "A", reasons: reasons.slice(0, 3), suppressor: null };
  }

  if (
    save.writes >= SAVE_NUDGE.tierBWrites &&
    save.pathHashes.length >= SAVE_NUDGE.tierBFiles &&
    save.turns >= SAVE_NUDGE.tierBTurns
  ) {
    return {
      fire: true,
      tier: "B",
      reasons: [
        `sustained work: ${save.writes} file edits across ${save.pathHashes.length} files over ${save.turns} turns`
      ],
      suppressor: null
    };
  }
  return no(null);
}

// Called by the CLI after a conversation save lands. It is what gives the
// "nothing file-modifying since the last save" suppressor something to compare
// against — without it, a session that just saved would be re-nudged by the
// very counters that earned the first nudge.
export function noteSaved(id) {
  if (!id) {
    return Promise.resolve(null);
  }
  return updateRouting((state) => {
    const save = normalizeSaveState(state.sessions[id]?.save);
    save.lastSaveAt = new Date().toISOString();
    save.writesAtSave = save.writes;
    state.sessions[id] = { ...state.sessions[id], save, updatedAt: new Date().toISOString() };
  });
}

// What the blocked Stop hands the model. It instructs, never saves: the save
// itself stays behind /neatcontext:save with its preview-and-confirm, run by
// the user. Silence is explicitly permitted — without it the false-positive
// rate would be unmanageable.
export function proposalInstruction({ reasons, liteConnectedName = null }) {
  const target = liteConnectedName
    ? `update "${liteConnectedName}" by running /neatcontext:save, save as a new context with /neatcontext:save <new name>`
    : "save it as a new context by running /neatcontext:save <name>";
  return [
    `NeatContext save check (automatic, at most once per session). Signals: ${reasons.join("; ")}.`,
    "Decide whether THIS conversation produced durable knowledge a future session would reuse — root causes found, decisions made and why, designs agreed, commands verified.",
    `- If it did: ask the user, opening with the exact line "${PROPOSAL_MARKER}" followed by up to three concrete items from this session that would be saved. Name the actual findings, files, or decisions — never generic benefits of saving. Close with the choices: ${target}, or reply "not now".`,
    "- Saving is the user's action. Never run a save, never write context files, never invoke commands for them.",
    "- If nothing here is durable (routine edits, exploration, sensitive material), do not mention saving or this check at all — reply with one short closing line and stop.",
    '- If the user answers "not now", drop the subject for the rest of the session.'
  ].join("\n");
}
