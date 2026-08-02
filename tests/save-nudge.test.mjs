// The save nudge: detecting a moment worth proposing /neatcontext:save.
//
// The property these tests protect is the two-layer split: the hook processes
// decide only *when* a save could be worth proposing — the session's model
// decides *whether* there is anything durable, and silence is a permitted
// answer. So the assertions are mostly about restraint: what the gate refuses
// to fire on, what the counters refuse to remember, and how a session that has
// already been asked once is left alone.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-code",
  "neatcontext"
);
const stopHook = path.join(plugin, "hooks", "stop.mjs");
const preCompactHook = path.join(plugin, "hooks", "pre-compact.mjs");

let home;
let companionFile;
let routingFile;
let transcriptCounter = 0;

process.env.NEATCONTEXT_COMPANION_FILE = "";
const {
  PROPOSAL_MARKER,
  SAVE_NUDGE,
  emptySaveState,
  evaluateSaveNudge,
  ingestTranscriptText,
  normalizeSaveState,
  noteSaved,
  proposalInstruction
} = await import("../plugins/claude-code/neatcontext/src/core/save-nudge.mjs");
const { hashSource, readRouting, setMode } = await import(
  "../plugins/claude-code/neatcontext/src/core/routing.mjs"
);

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-save-nudge-test-"));
  companionFile = path.join(home, "companion.json");
  process.env.NEATCONTEXT_COMPANION_FILE = companionFile;
  routingFile = path.join(home, "plugin-routing.json");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(routingFile, { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
});

// --- fixtures ------------------------------------------------------------------

const assistantLine = (blocks, usage) =>
  JSON.stringify({ type: "assistant", message: { content: blocks, ...(usage ? { usage } : {}) } });
const toolUse = (name, input, id = "t1") => ({ type: "tool_use", id, name, input });
const resultLine = (id, isError = false) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] }
  });

// A committed edit: the strongest Tier A completion beat.
const commitLines = [
  assistantLine([toolUse("Edit", { file_path: "/repo/src/app.mjs" })]),
  assistantLine([toolUse("Bash", { command: "git commit -m done" }, "bash-1")]),
  resultLine("bash-1")
];

async function writeTranscript(lines) {
  const file = path.join(home, `transcript-${transcriptCounter++}.jsonl`);
  await writeFile(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

async function connectLite(sessionId, name = "Payments Runbooks") {
  await mkdir(path.join(home, "plugin-sessions"), { recursive: true });
  await writeFile(
    path.join(home, "plugin-sessions", `${sessionId}.json`),
    JSON.stringify({ kind: "lite", liteContextId: "lite:pay", contextName: name })
  );
}

function runHook(script, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, NEATCONTEXT_COMPANION_FILE: companionFile }
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => resolve({ out: out.trim(), code }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const stop = (sessionId, transcript, extra = {}) =>
  runHook(stopHook, {
    session_id: sessionId,
    transcript_path: transcript,
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...extra
  });

const saveState = async (sessionId) => (await readRouting()).sessions[sessionId]?.save;

// --- the gate ------------------------------------------------------------------

describe("evaluateSaveNudge", () => {
  const armed = (overrides = {}) => ({
    ...emptySaveState(),
    writes: 1,
    commitLanded: true,
    ...overrides
  });

  it("fires on a landed commit, and says so", () => {
    const verdict = evaluateSaveNudge(armed(), { mode: "ask" });
    assert.equal(verdict.fire, true);
    assert.equal(verdict.tier, "A");
    assert.match(verdict.reasons.join(" "), /commit or pull request just landed/);
  });

  it("fires on red-then-green, compaction, and a filling window", () => {
    for (const overrides of [
      { redGreen: true },
      { compactPending: true },
      { peakTokens: SAVE_NUDGE.contextTokens },
      { transcriptBytes: SAVE_NUDGE.transcriptBytes }
    ]) {
      const verdict = evaluateSaveNudge(armed({ commitLanded: false, ...overrides }), { mode: "ask" });
      assert.equal(verdict.fire, true, JSON.stringify(overrides));
      assert.equal(verdict.tier, "A");
    }
  });

  it("fires when work keeps moving on a connected lite context, naming it", () => {
    const verdict = evaluateSaveNudge(
      armed({ commitLanded: false, writes: 3, writesAtConnect: 0 }),
      { mode: "ask", liteConnectedName: "Payments Runbooks" }
    );
    assert.equal(verdict.fire, true);
    assert.match(verdict.reasons[0], /"Payments Runbooks" — 3 file changes/);
  });

  it("does not treat the connected-context signal as armed without the connection", () => {
    const verdict = evaluateSaveNudge(armed({ commitLanded: false, writes: 3 }), { mode: "ask" });
    assert.equal(verdict.fire, false);
  });

  it("fires tier B only on sustained work: writes, files, and turns together", () => {
    const sustained = armed({
      commitLanded: false,
      writes: SAVE_NUDGE.tierBWrites,
      pathHashes: ["a", "b", "c"],
      turns: SAVE_NUDGE.tierBTurns
    });
    assert.equal(evaluateSaveNudge(sustained, { mode: "ask" }).tier, "B");
    for (const short of [
      { writes: SAVE_NUDGE.tierBWrites - 1 },
      { pathHashes: ["a", "b"] },
      { turns: SAVE_NUDGE.tierBTurns - 1 }
    ]) {
      assert.equal(evaluateSaveNudge({ ...sustained, ...short }, { mode: "ask" }).fire, false);
    }
  });

  it("is suppressed by each of the quiet conditions", () => {
    const cases = [
      [{ mode: "manual" }, armed(), "manual-mode"],
      [{ mode: "ask" }, armed({ proposalVisible: true }), "already-proposed"],
      [{ mode: "ask" }, armed({ fires: SAVE_NUDGE.maxFires }), "fire-budget"],
      [{ mode: "ask" }, armed({ awaitingMarker: true }), "fire-unresolved"],
      [{ mode: "ask" }, armed({ writes: 0 }), "no-writes"],
      [{ mode: "ask" }, armed({ buildRed: true }), "mid-flight"],
      [{ mode: "ask" }, armed({ lastSaveAt: "2026-08-01T00:00:00Z", writesAtSave: 1 }), "nothing-since-save"],
      [{ mode: "ask" }, armed({ fires: 1, writesAtFire: 1 }), "nothing-since-fire"]
    ];
    for (const [context, save, suppressor] of cases) {
      const verdict = evaluateSaveNudge(save, context);
      assert.equal(verdict.fire, false, suppressor);
      assert.equal(verdict.suppressor, suppressor);
    }
  });

  it("re-arms after a silent fire once the session has moved on", () => {
    const verdict = evaluateSaveNudge(armed({ fires: 1, writesAtFire: 1, writes: 2 }), { mode: "ask" });
    assert.equal(verdict.fire, true);
  });
});

// --- the instruction -------------------------------------------------------------

describe("proposalInstruction", () => {
  it("demands the marker, concrete items, and permits silence", () => {
    const text = proposalInstruction({ reasons: ["a commit or pull request just landed"] });
    assert.match(text, new RegExp(PROPOSAL_MARKER.replace("?", "\\?")));
    assert.match(text, /up to three concrete items/);
    assert.match(text, /do not mention saving or this check at all/);
    assert.match(text, /Never run a save/);
    assert.match(text, /\/neatcontext:save <name>/);
  });

  // The host prints this text in the terminal next to the hook's error line,
  // so it is user-facing whether or not it was written to be. An instruction
  // that sprawls produces an ask that sprawls, and the ask was not requested.
  it("caps the ask and stays short enough to sit in a terminal", () => {
    const text = proposalInstruction({
      reasons: ["a commit or pull request just landed", "the conversation is approaching auto-compaction"]
    });
    assert.match(text, /at most five lines/);
    assert.match(text, /one short line each/);
    assert.match(text, /No preamble, no reasoning/);
    assert.ok(
      text.split("\n").length <= 4,
      `the instruction itself must stay within four lines, got ${text.split("\n").length}`
    );
    assert.ok(text.length <= 700, `the instruction must stay terse, got ${text.length} characters`);
  });

  it("offers updating the connected context by name", () => {
    const text = proposalInstruction({
      reasons: ["x"],
      liteConnectedName: "INC-1001 checkout-api pool exhaustion"
    });
    assert.match(text, /update "INC-1001 checkout-api pool exhaustion" with \/neatcontext:save/);
  });
});

// --- the counters ----------------------------------------------------------------

describe("ingesting the transcript delta", () => {
  it("counts edits and keeps hashes, never paths", () => {
    const save = emptySaveState();
    ingestTranscriptText(
      save,
      [
        assistantLine([toolUse("Edit", { file_path: "/repo/secret/place.mjs" })]),
        assistantLine([toolUse("Write", { file_path: "/repo/secret/place.mjs" }, "t2")]),
        assistantLine([toolUse("Edit", { file_path: "/repo/other.mjs" }, "t3")])
      ].join("\n")
    );
    assert.equal(save.writes, 3);
    assert.deepEqual(save.pathHashes, [hashSource("/repo/secret/place.mjs"), hashSource("/repo/other.mjs")]);
    assert.doesNotMatch(JSON.stringify(save), /secret|place|repo/);
  });

  it("sees a commit land only when its result is not an error", () => {
    const save = emptySaveState();
    ingestTranscriptText(
      save,
      [assistantLine([toolUse("Bash", { command: "git commit -m x" }, "b1")]), resultLine("b1", true)].join("\n")
    );
    assert.equal(save.commitLanded, false);
    assert.equal(save.buildRed, true);

    ingestTranscriptText(
      save,
      [assistantLine([toolUse("Bash", { command: "git commit -m x" }, "b2")]), resultLine("b2")].join("\n")
    );
    assert.equal(save.commitLanded, true);
    assert.equal(save.buildRed, false);
    // git failed, then git succeeded: that is also the red-then-green beat.
    assert.equal(save.redGreen, true);
  });

  // Found live: models routinely commit as `git add x && git commit -m y`,
  // and the commit is never the first segment of that compound.
  it("sees a commit buried in a compound command", () => {
    const save = emptySaveState();
    ingestTranscriptText(
      save,
      [
        assistantLine([toolUse("Bash", { command: "git add notes.txt && git commit -m add-notes" }, "b1")]),
        resultLine("b1")
      ].join("\n")
    );
    assert.equal(save.commitLanded, true);
  });

  it("treats only build-shaped commands as mid-flight when they fail", () => {
    const save = emptySaveState();
    // A grep exiting non-zero is a normal answer, not a broken build.
    ingestTranscriptText(
      save,
      [assistantLine([toolUse("Bash", { command: "rg missing-symbol src" }, "b1")]), resultLine("b1", true)].join("\n")
    );
    assert.equal(save.buildRed, false);

    ingestTranscriptText(
      save,
      [assistantLine([toolUse("Bash", { command: "npm test" }, "b2")]), resultLine("b2", true)].join("\n")
    );
    assert.equal(save.buildRed, true);
  });

  it("tracks the context-fill high-water mark from usage fields", () => {
    const save = emptySaveState();
    ingestTranscriptText(
      save,
      [
        assistantLine([], { input_tokens: 1000, cache_read_input_tokens: 40_000 }),
        assistantLine([], { input_tokens: 500, cache_read_input_tokens: 20_000 })
      ].join("\n")
    );
    assert.equal(save.peakTokens, 41_000);
  });

  it("notices the proposal marker only while a fire is unresolved", () => {
    const line = assistantLine([{ type: "text", text: `${PROPOSAL_MARKER} — the root cause; the fix.` }]);
    const idle = emptySaveState();
    assert.equal(ingestTranscriptText(idle, line), false);

    const awaiting = { ...emptySaveState(), awaitingMarker: true };
    assert.equal(ingestTranscriptText(awaiting, line), true);
  });

  it("caps the pending-tool map by evicting the oldest entry", () => {
    const save = emptySaveState();
    const flood = [];
    for (let i = 0; i < SAVE_NUDGE.maxPendingTools + 1; i++) {
      flood.push(assistantLine([toolUse("Bash", { command: `npm run task-${i}` }, `b${i}`)]));
    }
    ingestTranscriptText(save, flood.join("\n"));
    assert.equal(Object.keys(save.pending).length, SAVE_NUDGE.maxPendingTools);
    assert.equal(save.pending.b0, undefined, "the oldest waiter is the one evicted");
    // The evicted call's late result is silently ignored, not miscounted.
    ingestTranscriptText(save, resultLine("b0", true));
    assert.equal(save.buildRed, false);
  });

  it("survives garbage lines and unknown shapes", () => {
    const save = emptySaveState();
    ingestTranscriptText(save, 'not json\n{"type":"summary"}\n{"type":"user","message":{}}\n');
    assert.deepEqual(save, emptySaveState());
  });

  it("normalizes hand-broken stored state into something runnable", () => {
    const clean = normalizeSaveState({ writes: "many", turns: 4, pathHashes: [1, "ok"], nonsense: true });
    assert.equal(clean.writes, 0);
    assert.equal(clean.turns, 4);
    assert.deepEqual(clean.pathHashes, ["ok"]);
    assert.equal(clean.nonsense, undefined);
    assert.deepEqual(normalizeSaveState(null), emptySaveState());
  });
});

// --- the Stop hook ---------------------------------------------------------------

describe("the Stop hook", () => {
  it("blocks with the ask when a commit lands, and records the fire", async () => {
    const transcript = await writeTranscript(commitLines);
    const { out, code } = await stop("s1", transcript);
    assert.equal(code, 0);
    const output = JSON.parse(out);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /commit or pull request just landed/);
    assert.match(output.reason, /Worth saving this session\?/);

    const save = await saveState("s1");
    assert.equal(save.fires, 1);
    assert.equal(save.awaitingMarker, true);
    const { decisions } = await readRouting();
    assert.equal(decisions.at(-1).kind, "save-nudge");
    assert.equal(decisions.at(-1).outcome, "fired");
  });

  it("offers the connected lite context as the update target", async () => {
    await connectLite("s-lite");
    const transcript = await writeTranscript(commitLines);
    const { out } = await stop("s-lite", transcript);
    assert.match(JSON.parse(out).reason, /update "Payments Runbooks" with \/neatcontext:save/);
  });

  it("stays quiet with nothing worth proposing", async () => {
    const transcript = await writeTranscript([
      assistantLine([toolUse("Read", { file_path: "/repo/a.mjs" })])
    ]);
    const { out, code } = await stop("s2", transcript);
    assert.equal(out, "");
    assert.equal(code, 0);
    assert.equal((await saveState("s2")).turns, 1);
  });

  it("never blocks the continuation it forced itself", async () => {
    const transcript = await writeTranscript(commitLines);
    const { out } = await stop("s3", transcript, { stop_hook_active: true });
    assert.equal(out, "");
    assert.equal(await saveState("s3"), undefined, "a guarded run does not even count the turn");
  });

  it("spends the session's one visible proposal when the marker appears", async () => {
    const transcript = await writeTranscript(commitLines);
    assert.equal(JSON.parse((await stop("s4", transcript)).out).decision, "block");

    // The model proposed; the marker is in the next delta.
    await writeFile(
      transcript,
      [
        ...commitLines,
        assistantLine([{ type: "text", text: `${PROPOSAL_MARKER} — the fix; the decision.` }])
      ]
        .map((line) => `${line}\n`)
        .join("")
    );
    assert.equal((await stop("s4", transcript)).out, "", "resolution turn does not re-fire");
    const save = await saveState("s4");
    assert.equal(save.proposalVisible, true);
    assert.equal((await readRouting()).decisions.at(-1).outcome, "proposed");

    // A later commit changes nothing: the user has been asked once.
    await writeFile(
      transcript,
      [
        ...commitLines,
        assistantLine([{ type: "text", text: `${PROPOSAL_MARKER} …` }]),
        assistantLine([toolUse("Edit", { file_path: "/repo/more.mjs" }, "t9")]),
        assistantLine([toolUse("Bash", { command: "git commit -m again" }, "b9")]),
        resultLine("b9")
      ]
        .map((line) => `${line}\n`)
        .join("")
    );
    assert.equal((await stop("s4", transcript)).out, "");
  });

  it("re-arms after model silence, but only once the session moves on", async () => {
    const transcript = await writeTranscript(commitLines);
    assert.equal(JSON.parse((await stop("s5", transcript)).out).decision, "block");

    // No marker in the next delta: the model judged nothing durable.
    assert.equal((await stop("s5", transcript)).out, "", "same evidence does not re-fire");
    assert.equal((await readRouting()).decisions.at(-1).outcome, "silent");

    // New work and a new completion beat: the gate opens again.
    await writeFile(
      transcript,
      [
        ...commitLines,
        assistantLine([toolUse("Edit", { file_path: "/repo/more.mjs" }, "t9")]),
        assistantLine([toolUse("Bash", { command: "git commit -m again" }, "b9")]),
        resultLine("b9")
      ]
        .map((line) => `${line}\n`)
        .join("")
    );
    assert.equal(JSON.parse((await stop("s5", transcript)).out).decision, "block");
    assert.equal((await saveState("s5")).fires, 2);
  });

  it("is off in manual mode, along with routing", async () => {
    await setMode("manual", { global: true });
    const transcript = await writeTranscript(commitLines);
    assert.equal((await stop("s6", transcript)).out, "");
  });

  it("does nothing without a session to remember anything against", async () => {
    const transcript = await writeTranscript(commitLines);
    assert.equal((await stop("", transcript)).out, "");
    assert.deepEqual((await readRouting()).sessions, {});
  });

  it("starts over when the transcript is smaller than the stored offset", async () => {
    const transcript = await writeTranscript([...commitLines, ...commitLines, ...commitLines]);
    await stop("s7", transcript);
    const grown = (await saveState("s7")).transcriptOffset;

    // A rotated or resumed transcript: shorter than what was already counted.
    await writeFile(transcript, `${assistantLine([toolUse("Read", { file_path: "/x" })])}\n`);
    await stop("s7", transcript);
    const save = await saveState("s7");
    assert.ok(save.transcriptOffset < grown);
    assert.equal(save.transcriptOffset, (await readFile(transcript, "utf8")).length);
  });
});

// --- PreCompact and the save handshake --------------------------------------------

describe("the PreCompact hook", () => {
  it("arms the post-compact turn, once", async () => {
    await runHook(preCompactHook, { session_id: "s8", trigger: "auto", hook_event_name: "PreCompact" });
    assert.equal((await saveState("s8")).compactPending, true);

    // One quiet edit is enough once compaction is the reason.
    const transcript = await writeTranscript([
      assistantLine([toolUse("Edit", { file_path: "/repo/a.mjs" })])
    ]);
    const { out } = await stop("s8", transcript);
    assert.match(JSON.parse(out).reason, /just compacted/);
    // Consumed: a compaction from earlier must not read as "just compacted" later.
    assert.equal((await saveState("s8")).compactPending, false);
  });
});

describe("noteSaved", () => {
  it("quiets the nudge until something file-modifying happens again", async () => {
    const transcript = await writeTranscript(commitLines);
    await stop("s9", transcript);
    await noteSaved("s9");

    const save = await saveState("s9");
    assert.ok(save.lastSaveAt);
    assert.equal(save.writesAtSave, save.writes);
    // Even once the fire itself is resolved, the save keeps the gate closed.
    assert.equal(
      evaluateSaveNudge({ ...save, awaitingMarker: false }, { mode: "ask" }).suppressor,
      "nothing-since-save"
    );
  });

  it("records nothing without a session", async () => {
    assert.equal(await noteSaved(null), null);
    assert.deepEqual((await readRouting()).sessions, {});
  });
});
