// The plugin no longer decides when to save. What is left of the per-session
// state is one recorded fact — where Claude keeps this session's transcript —
// because `/neatcontext:save` needs it and only a hook is told it.
//
// These tests pin both halves: the module that screens and normalizes the
// value, and the two hooks that write it. The hooks matter most: they run on
// every turn of every session, and the whole point of the change is that the
// user never hears from them.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  emptySaveState,
  normalizeSaveState,
  rememberTranscriptPath
} from "../plugins/claude-code/neatcontext/src/core/session-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..", "plugins", "claude-code", "neatcontext");
const stopHook = path.join(pluginRoot, "hooks", "stop.mjs");
const preCompactHook = path.join(pluginRoot, "hooks", "pre-compact.mjs");

function runHook(hook, input, contextHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      cwd: pluginRoot,
      env: { ...process.env, NEATCONTEXT_HOME: contextHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function isolatedHome() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "neatcontext-session-state-"));
  return {
    directory,
    routingFile: path.join(directory, "plugin-routing.json")
  };
}

test("save state carries the transcript path and nothing else", () => {
  assert.deepEqual(emptySaveState(), { transcriptPath: null });

  for (const raw of [null, undefined, "string", 7, []]) {
    assert.deepEqual(normalizeSaveState(raw), { transcriptPath: null });
  }

  assert.deepEqual(normalizeSaveState({ transcriptPath: "/tmp/a.jsonl" }), {
    transcriptPath: "/tmp/a.jsonl"
  });
  assert.deepEqual(normalizeSaveState({ transcriptPath: 42 }), { transcriptPath: null });

  // The retired nudge counters are dropped rather than carried forward, which
  // is how they leave plugin-routing.json without a migration step.
  const legacy = {
    transcriptPath: "/tmp/b.jsonl",
    turns: 31,
    writes: 51,
    fires: 2,
    proposalVisible: true,
    awaitingMarker: true,
    pathHashes: ["deadbeef"],
    compactPending: true
  };
  assert.deepEqual(normalizeSaveState(legacy), { transcriptPath: "/tmp/b.jsonl" });
});

test("a recorded transcript path is screened before it is stored", () => {
  const save = emptySaveState();

  assert.equal(rememberTranscriptPath(save, "  /tmp/session.jsonl  "), true);
  assert.equal(save.transcriptPath, "/tmp/session.jsonl", "surrounding whitespace is trimmed");

  // The value arrives from the host on stdin and is later opened, so anything
  // that is not a plausible single-line path is refused outright, leaving the
  // previously recorded value alone.
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "   ",
    "/tmp/a\nb.jsonl",
    "/tmp/a\rb.jsonl",
    "/tmp/a\0b.jsonl",
    `/tmp/${"x".repeat(32_769)}.jsonl`
  ]) {
    assert.equal(rememberTranscriptPath(save, bad), false, `must reject ${JSON.stringify(bad)}`);
    assert.equal(save.transcriptPath, "/tmp/session.jsonl", "a rejected value changes nothing");
  }
});

test("the hooks record the transcript path and never say anything", async () => {
  const home = await isolatedHome();
  const transcript = path.join(home.directory, "session.jsonl");
  await writeFile(transcript, "{}\n", "utf8");
  const sessionId = "hook-session-a";

  for (const [hook, payload] of [
    [stopHook, { session_id: sessionId, transcript_path: transcript, stop_hook_active: false }],
    [preCompactHook, { session_id: sessionId, transcript_path: transcript, trigger: "auto" }]
  ]) {
    const result = await runHook(hook, JSON.stringify(payload), home.directory);
    assert.equal(result.code, 0, `${path.basename(hook)} must exit 0`);
    assert.equal(result.stdout, "", `${path.basename(hook)} must print nothing`);
    assert.equal(result.stderr, "", `${path.basename(hook)} must warn about nothing`);
  }

  const routing = JSON.parse(await readFile(home.routingFile, "utf8"));
  assert.deepEqual(routing.sessions[sessionId].save, { transcriptPath: transcript });
  assert.deepEqual(
    routing.decisions.filter((entry) => entry.kind === "save-nudge"),
    [],
    "nothing may log a save-nudge decision any more"
  );
});

// Rewriting the routing file every turn is what aged other sessions out of its
// 20-entry cap, which is how the old nudge lost its own "already asked" state.
test("an unchanged transcript path does not rewrite the routing file", async () => {
  const home = await isolatedHome();
  const transcript = path.join(home.directory, "session.jsonl");
  await writeFile(transcript, "{}\n", "utf8");
  const sessionId = "hook-session-b";
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcript });

  await runHook(stopHook, payload, home.directory);

  // A sentinel the hook would overwrite if it wrote at all.
  const before = JSON.parse(await readFile(home.routingFile, "utf8"));
  before.sessions[sessionId].updatedAt = "1999-01-01T00:00:00.000Z";
  await writeFile(home.routingFile, `${JSON.stringify(before, null, 2)}\n`, "utf8");

  await runHook(stopHook, payload, home.directory);
  const after = JSON.parse(await readFile(home.routingFile, "utf8"));
  assert.equal(after.sessions[sessionId].updatedAt, "1999-01-01T00:00:00.000Z");

  // A genuinely new path is still recorded.
  const moved = path.join(home.directory, "resumed.jsonl");
  await writeFile(moved, "{}\n", "utf8");
  await runHook(
    stopHook,
    JSON.stringify({ session_id: sessionId, transcript_path: moved }),
    home.directory
  );
  const moved_state = JSON.parse(await readFile(home.routingFile, "utf8"));
  assert.equal(moved_state.sessions[sessionId].save.transcriptPath, moved);
  assert.notEqual(moved_state.sessions[sessionId].updatedAt, "1999-01-01T00:00:00.000Z");
});

test("a hook given nothing usable stays silent and writes nothing", async () => {
  const home = await isolatedHome();

  for (const [input, label] of [
    ["", "empty stdin"],
    ["not json", "malformed stdin"],
    ["{}", "no session id"],
    [JSON.stringify({ session_id: "hook-session-c" }), "no transcript path"],
    [JSON.stringify({ session_id: "hook-session-c", transcript_path: "  " }), "blank path"]
  ]) {
    for (const hook of [stopHook, preCompactHook]) {
      const result = await runHook(hook, input, home.directory);
      assert.equal(result.code, 0, `${path.basename(hook)} must exit 0 on ${label}`);
      assert.equal(result.stdout + result.stderr, "", `${path.basename(hook)} silent on ${label}`);
    }
  }

  await assert.rejects(() => readFile(home.routingFile, "utf8"), "nothing usable writes no state");
});
