// E2E: the save nudge is gone, and what replaced it stays silent.
//
// Drives the real hook scripts and the real CLI as child processes, the way
// Claude Code does, against an isolated NeatContext home.
//
//   node e2e-no-nudge.mjs <repo-root>

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = process.argv[2];
const plugin = path.join(repo, "plugins", "claude-code", "neatcontext");
const stopHook = path.join(plugin, "hooks", "stop.mjs");
const preCompactHook = path.join(plugin, "hooks", "pre-compact.mjs");
const cli = path.join(plugin, "src", "claude", "neatcontext-cli.mjs");

const home = await mkdtemp(path.join(os.tmpdir(), "e2e-no-nudge-"));
const discovery = path.join(home, "companion.json");
const routingFile = path.join(home, "plugin-routing.json");
const sessionId = "e2e-session-0001";
const env = { ...process.env, NEATCONTEXT_COMPANION_FILE: discovery, CLAUDE_CODE_SESSION_ID: sessionId };

function run(script, args, { input, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// A small but realistic Claude transcript, so the evidence path has something
// to compile rather than being trivially "unavailable".
const transcript = path.join(home, `${sessionId}.jsonl`);
await writeFile(
  transcript,
  [
    { type: "user", message: { role: "user", content: "The checkout worker stalls on partition 17." } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Large events from catalog-sync share a partition key, which blocks later orders." }]
      }
    },
    { type: "user", message: { role: "user", content: "Splitting the bulk updates cleared the lag." } }
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
  "utf8"
);

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error.message.split("\n")[0]}`);
  }
};

console.log("1. Stop hook over 25 consecutive turns (the nudge used to fire in this window)");
const stopPayload = JSON.stringify({
  session_id: sessionId,
  transcript_path: transcript,
  stop_hook_active: false,
  cwd: repo
});
let anyOutput = "";
for (let turn = 0; turn < 25; turn += 1) {
  const result = await run(stopHook, [], { input: stopPayload });
  anyOutput += result.stdout + result.stderr;
  if (result.code !== 0) {
    failures += 1;
    console.log(`  FAIL  turn ${turn} exited ${result.code}`);
    break;
  }
}
check("every turn produced zero stdout/stderr", () => assert.equal(anyOutput, ""));
check("nothing resembling a save prompt was emitted", () =>
  assert.doesNotMatch(anyOutput, /Worth saving|additionalContext|hookSpecificOutput/)
);

console.log("2. PreCompact hook");
const pre = await run(preCompactHook, [], {
  input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, trigger: "auto" })
});
check("exited 0 silently", () => {
  assert.equal(pre.code, 0);
  assert.equal(pre.stdout + pre.stderr, "");
});

console.log("3. Routing state holds only the transcript path");
const routing = JSON.parse(await readFile(routingFile, "utf8"));
const save = routing.sessions[sessionId].save;
check("transcript path recorded", () => assert.equal(save.transcriptPath, transcript));
check("no nudge counters survive", () =>
  assert.deepEqual(Object.keys(save).sort(), ["transcriptPath"])
);
check("no save-nudge decisions were logged", () =>
  assert.equal(routing.decisions.filter((d) => d.kind === "save-nudge").length, 0)
);

console.log("4. PR #52 conversation evidence still works from that path");
const evidence = await run(cli, ["evidence"]);
check("evidence command succeeded", () => assert.equal(evidence.code, 0));
check("evidence compiled rather than reporting unavailable", () => {
  assert.doesNotMatch(evidence.stdout, /Conversation evidence is unavailable/);
  assert.match(evidence.stdout, /catalog-sync|partition|B0001/i);
});

console.log("5. Hostile input still cannot break a stop");
for (const [input, label] of [
  ["", "empty stdin"],
  ["not json", "garbage stdin"],
  ["{}", "no session id"],
  [JSON.stringify({ session_id: sessionId }), "no transcript path"]
]) {
  const r = await run(stopHook, [], { input });
  check(`${label}: exit 0, silent`, () => {
    assert.equal(r.code, 0);
    assert.equal(r.stdout + r.stderr, "");
  });
}

console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
