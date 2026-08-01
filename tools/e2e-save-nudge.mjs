#!/usr/bin/env node
// Live end-to-end check of the save nudge against an installed Claude Code.
//
// The unit suite (tests/save-nudge.test.mjs) proves the gate and the counters;
// what it cannot prove is the host contract the hooks were written against.
// This script runs the real `claude` CLI headless and verifies exactly those
// assumptions:
//
//   1. Stop hook input carries session_id, transcript_path, stop_hook_active.
//   2. {"decision": "block", "reason"} forces a continuation the model can
//      read, and the follow-up Stop arrives with stop_hook_active: true.
//   3. The real transcript contains the usage fields and tool shapes the
//      whitelist ingestion reads.
//   4. The shipped hooks, wired end to end, record a fire and deliver the ask
//      in a session that edits a file and commits.
//
// Local-only, deliberately not named *.test.mjs: it needs an authenticated
// claude CLI and spends a few small model calls. Run it by hand before a
// release: node tools/e2e-save-nudge.mjs [--keep]

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stopHook = path.join(repo, "plugins", "claude-code", "neatcontext", "hooks", "stop.mjs");
const keep = process.argv.includes("--keep");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// The CLI must not believe it is nested inside this very session.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// No shell anywhere: prompts carry text like `&&` that a shell would execute
// instead of passing along. On Windows that means resolving the .exe by hand.
function resolveExecutable(command) {
  if (process.platform !== "win32") {
    return command;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(dir, command + suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

function run(command, args, { cwd, env, timeoutMs = 180_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(resolveExecutable(command), args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// Trust is re-asserted before every invocation: a previous claude process
// flushes its own snapshot of ~/.claude.json on exit, and last writer wins.
// No --settings flag: the .claude/settings.json in cwd already loads as
// project settings, and passing it again changed how permissions were applied.
const claude = async (args, options) => {
  await trustProject(options.cwd);
  return run("claude", ["--model", "haiku", ...args], options);
};

// Headless runs in a fresh directory hit the trust dialog, which nothing can
// click. Trust is granted per project path in ~/.claude.json, so the harness
// adds entries for its scratch directories — every spelling Windows might use
// for them — and removes exactly those entries afterwards.
const claudeJsonPath = path.join(os.homedir(), ".claude.json");
const trustedKeys = new Set();

async function trustProject(dir) {
  // `.native` matters on Windows: it expands 8.3 short names (MAZONG~1) to
  // the long form claude uses as its project key; plain realpathSync does not.
  const variants = new Set([path.resolve(dir), realpathSync(dir), realpathSync.native(dir)]);
  for (const variant of [...variants]) {
    variants.add(variant.replaceAll("\\", "/"));
  }
  let config = {};
  try {
    config = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  } catch {
    // A missing file just means claude has never run; it will merge ours.
  }
  config.projects ??= {};
  for (const key of variants) {
    config.projects[key] = { ...config.projects[key], hasTrustDialogAccepted: true };
    trustedKeys.add(key);
  }
  await writeFile(claudeJsonPath, JSON.stringify(config, null, 2));
}

async function untrustProjects() {
  if (trustedKeys.size === 0) return;
  try {
    const config = JSON.parse(await readFile(claudeJsonPath, "utf8"));
    for (const key of trustedKeys) {
      delete config.projects?.[key];
    }
    await writeFile(claudeJsonPath, JSON.stringify(config, null, 2));
  } catch {
    // Leaving a stale trust entry for a deleted temp directory is harmless.
  }
}

async function writeHookSettings(dir, hooks, permissions) {
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "settings.json"),
    JSON.stringify({ hooks, ...(permissions ? { permissions } : {}) }, null, 2)
  );
  await trustProject(dir);
}

const readJsonl = async (file) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

// --- phase 1: the raw Stop contract, via a probe hook --------------------------

async function probeStopContract(root) {
  const dir = path.join(root, "probe");
  const log = path.join(dir, "stop-log.jsonl");
  const once = path.join(dir, "blocked-once");
  await mkdir(dir, { recursive: true });

  // Logs every Stop input it sees; blocks exactly once, with a reason the
  // model can only satisfy by having read it.
  const probe = path.join(dir, "probe-stop.mjs");
  await writeFile(
    probe,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
appendFileSync(${JSON.stringify(log)}, raw.replace(/\\n/g, " ") + "\\n");
const input = JSON.parse(raw);
if (!input.stop_hook_active && !existsSync(${JSON.stringify(once)})) {
  writeFileSync(${JSON.stringify(once)}, "1");
  process.stdout.write(JSON.stringify({ decision: "block", reason: "Respond with exactly the single word NUDGEACK and nothing else." }));
}
`
  );
  await writeHookSettings(dir, {
    Stop: [{ hooks: [{ type: "command", command: `node "${probe}"`, timeout: 15 }] }]
  });

  const { out, err } = await claude(["-p", "Reply with exactly: HELLO"], {
    cwd: dir,
    env: cleanEnv()
  });

  const entries = await readJsonl(log);
  const first = entries[0] ?? {};
  record(
    "Stop input carries session_id and an existing transcript_path",
    typeof first.session_id === "string" &&
      first.session_id.length > 0 &&
      typeof first.transcript_path === "string" &&
      (await readFile(first.transcript_path, "utf8").catch(() => null)) !== null,
    JSON.stringify(Object.keys(first))
  );
  record(
    "blocked Stop forces a continuation the model reads (NUDGEACK in output)",
    out.includes("NUDGEACK"),
    out.trim().slice(-80) || err.trim().slice(-120)
  );
  record(
    "the follow-up Stop arrives guarded with stop_hook_active: true",
    entries.some((entry) => entry.stop_hook_active === true),
    `stop invocations: ${entries.length}`
  );

  if (typeof first.transcript_path === "string") {
    const lines = await readJsonl(first.transcript_path).catch(() => []);
    const assistant = lines.find((line) => line.type === "assistant" && line.message?.usage);
    record(
      "live transcript carries the usage fields the whitelist reads",
      typeof assistant?.message.usage.input_tokens === "number",
      assistant ? `input_tokens=${assistant.message.usage.input_tokens}` : "no assistant usage entry"
    );
  }
}

// --- phase 2: the shipped hooks, end to end -------------------------------------

async function liveFeature(root) {
  const dir = path.join(root, "feature");
  const home = path.join(root, "feature-home");
  await mkdir(dir, { recursive: true });
  await mkdir(home, { recursive: true });

  await run("git", ["init", "-q"], { cwd: dir, env: cleanEnv() });
  await run("git", ["config", "user.email", "e2e@example.invalid"], { cwd: dir, env: cleanEnv() });
  await run("git", ["config", "user.name", "e2e"], { cwd: dir, env: cleanEnv() });

  await writeHookSettings(
    dir,
    { Stop: [{ hooks: [{ type: "command", command: `node "${stopHook}"`, timeout: 15 }] }] },
    { allow: ["Write", "Edit", "Bash(git add:*)", "Bash(git commit:*)"] }
  );

  const { out, err } = await claude(
    [
      "-p",
      // Durable-sounding on purpose: with nothing worth saving the model is
      // *supposed* to take the silent branch, which would prove delivery but
      // not the ask itself.
      "We just finished debugging: the checkout 500s were caused by pgbouncer connection-pool exhaustion after dep-9001 cut default_pool_size from 40 to 5; a RELOAD restored it without dropping sessions. Use the Write tool to record exactly that root cause in findings.md, then run exactly: git add findings.md && git commit -m record-root-cause. Then say: COMMITTED.",
      "--allowedTools",
      "Write,Edit,Bash(git add:*),Bash(git commit:*)"
    ],
    { cwd: dir, env: cleanEnv({ NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json") }) }
  );

  let routing = {};
  try {
    routing = JSON.parse(await readFile(path.join(home, "plugin-routing.json"), "utf8"));
  } catch {
    // Left empty: the assertions below say what is missing.
  }
  const saves = Object.values(routing.sessions ?? {})
    .map((session) => session.save)
    .filter(Boolean);
  const fired = saves.find((save) => save.fires >= 1);
  record(
    "the shipped Stop hook counted the session and fired once",
    Boolean(fired) && fired.writes >= 1 && fired.awaitingMarker === true,
    fired ? `fires=${fired.fires} writes=${fired.writes} turns=${fired.turns}` : `sessions=${saves.length}; ${err.trim().slice(-120)}`
  );
  record(
    "the fire and its signals landed in the decisions log",
    (routing.decisions ?? []).some((entry) => entry.kind === "save-nudge" && entry.outcome === "fired"),
    JSON.stringify((routing.decisions ?? []).at(-1) ?? null)
  );
  // Both branches are designed behavior: the marker means the user got the
  // ask; a short closing line means the model took the permitted silent path.
  // Only a permission complaint or an unrelated ramble would be a failure.
  const proposed = out.includes("Worth saving this session?");
  record(
    "the blocked ask reached the model and it took a designed branch",
    proposed || (Boolean(fired) && !/permission|approve/i.test(out)),
    proposed ? `model proposed live: ${out.trim().slice(-160)}` : `model chose silence: ${out.trim().slice(-60)}`
  );
}

// --- phase 3: PreCompact registration -------------------------------------------

async function probePreCompact(root) {
  const dir = path.join(root, "precompact");
  const log = path.join(dir, "precompact-log.jsonl");
  await mkdir(dir, { recursive: true });
  const probe = path.join(dir, "probe-precompact.mjs");
  await writeFile(
    probe,
    `import { appendFileSync } from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
appendFileSync(${JSON.stringify(log)}, raw.replace(/\\n/g, " ") + "\\n");
`
  );
  await writeHookSettings(dir, {
    PreCompact: [{ matcher: "auto|manual", hooks: [{ type: "command", command: `node "${probe}"`, timeout: 15 }] }]
  });

  // A manual /compact is the only trigger cheap enough to attempt here.
  const first = await claude(["-p", "Reply with exactly: WARMED"], { cwd: dir, env: cleanEnv() });
  const sessionMatch = first.err.match(/session[- ]id[":\s]*([0-9a-f-]{36})/i);
  await claude(["-p", "--resume", ...(sessionMatch ? [sessionMatch[1]] : []), "/compact"], {
    cwd: dir,
    env: cleanEnv()
  }).catch(() => undefined);

  const entries = await readJsonl(log);
  const entry = entries.find((line) => line.hook_event_name === "PreCompact");
  if (entry) {
    record(
      "PreCompact fires through the auto|manual matcher with a session_id",
      typeof entry.session_id === "string" && ["auto", "manual"].includes(entry.trigger),
      `trigger=${entry.trigger}`
    );
  } else {
    console.log("SKIP  PreCompact could not be triggered headless — verify with /compact in an interactive session");
  }
}

// The long form, not the MAZONG~1 short form Windows hands out for tmpdir:
// claude's permission engine compares the cwd against the project path it
// trusts, and a short-path cwd reads as a different directory — every file
// write then looks out-of-project and is denied.
const root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "neatcontext-e2e-")));
console.log(`workspace: ${root}\n`);
try {
  // Every phase directory is trusted before the first claude process starts:
  // a claude process flushes its own snapshot of ~/.claude.json when it ends,
  // and a snapshot loaded before a later phase's trust entry existed would
  // erase it. Loading them all up front makes every snapshot carry them.
  for (const name of ["probe", "feature", "precompact"]) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await trustProject(dir);
  }
  await probeStopContract(root);
  await liveFeature(root);
  await probePreCompact(root);
} finally {
  await untrustProjects();
  if (!keep) await rm(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
