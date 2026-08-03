#!/usr/bin/env node
// Live end-to-end check of the save nudge against an installed Claude Code.
//
// The unit suite (tests/save-nudge.test.mjs) proves the gate and the counters;
// what it cannot prove is the host contract the hooks were written against.
// This script runs the real `claude` CLI headless and verifies exactly those
// assumptions:
//
//   1. Stop hook input carries session_id, transcript_path, stop_hook_active.
//   2. hookSpecificOutput.additionalContext forces a continuation the model can
//      read, the follow-up Stop arrives with stop_hook_active: true, and the
//      text never enters the conversation as a message the user would read.
//   3. The real transcript contains the usage fields and tool shapes the
//      whitelist ingestion reads.
//   4. The shipped hooks, wired end to end, record a fire and deliver the ask
//      in a session that edits a file and commits.
//   5. The exec form the manifest uses (`command: node`, script in `args`)
//      still delivers the payload on stdin, and passes arguments without a
//      shell in between.
//   6. Installed as a real plugin, ${CLAUDE_PLUGIN_ROOT} resolves inside
//      `args` and the hook actually runs.
//   7. The installed plugin is healthy, and a real /neatcontext:save uses the
//      evidence projection to create a redacted, reusable lite context.
//
// Local-only, deliberately not named *.test.mjs: it needs an authenticated
// claude CLI and spends a few small model calls. Run it by hand before a
// release: node tools/e2e-save-nudge.mjs [--keep] [--installed-only]

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Distinctive enough that finding it anywhere in the event stream means the
// host replayed the hook's payload rather than keeping it model-only.
const PROBE_MARKER = "NUDGEPROBEMARKER";
const stopHook = path.join(repo, "plugins", "claude-code", "neatcontext", "hooks", "stop.mjs");
const keep = process.argv.includes("--keep");
const installedOnly = process.argv.includes("--installed-only");

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

  // Logs every Stop input it sees; fires exactly once, with an instruction the
  // model can only satisfy by having read it. The marker rides along so the
  // visibility assertion below can look for it in the event stream.
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
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: "${PROBE_MARKER}: respond with exactly the single word NUDGEACK and nothing else."
    }
  }));
}
`
  );
  await writeHookSettings(dir, {
    Stop: [{ hooks: [{ type: "command", command: `node "${probe}"`, timeout: 15 }] }]
  });

  // stream-json exposes what plain -p cannot: whether the host replayed the
  // hook's text as a conversation message. A blocked Stop does exactly that,
  // as a user-role turn prefixed "Stop hook feedback:" — which is how the
  // instruction meant for the model ends up printed to the user.
  const { out, err } = await claude(
    ["-p", "Reply with exactly: HELLO", "--output-format", "stream-json", "--verbose"],
    { cwd: dir, env: cleanEnv() }
  );
  const events = out
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
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
    "additionalContext forces a continuation the model reads (NUDGEACK in output)",
    out.includes("NUDGEACK"),
    out.trim().slice(-80) || err.trim().slice(-120)
  );
  record(
    "the follow-up Stop arrives guarded with stop_hook_active: true",
    entries.some((entry) => entry.stop_hook_active === true),
    `stop invocations: ${entries.length}`
  );
  // The regression this guards: the model-facing instruction must never become
  // a conversation message, because the user reads those.
  const replayed = events.filter(
    (event) =>
      event.message?.role === "user" && JSON.stringify(event.message.content).includes(PROBE_MARKER)
  );
  record(
    "the hook's instruction never enters the conversation as a readable message",
    replayed.length === 0,
    replayed.length === 0
      ? "marker absent from the event stream"
      : `replayed as ${replayed.map((event) => `${event.type}/${event.message?.role ?? "-"}`).join(", ")}`
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
  // Not `awaitingMarker === true`: that only holds when the session happens to
  // end on the firing turn. If the model answers and stops again, the next Stop
  // resolves the fire — proposed or silent — and clears the flag. Both endings
  // are correct, so the fire is asserted here and its delivery two checks down.
  const resolved = (routing.decisions ?? []).some(
    (entry) => entry.kind === "save-nudge" && ["proposed", "silent"].includes(entry.outcome)
  );
  record(
    "the shipped Stop hook counted the session and fired once",
    Boolean(fired) && fired.writes >= 1 && (fired.awaitingMarker === true || resolved),
    fired
      ? `fires=${fired.fires} writes=${fired.writes} turns=${fired.turns} awaiting=${fired.awaitingMarker}`
      : `sessions=${saves.length}; ${err.trim().slice(-120)}`
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
    "the injected ask reached the model and it took a designed branch",
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

// --- phase 4: the exec form the manifest ships ----------------------------------

async function probeExecForm(root) {
  const dir = path.join(root, "execform");
  const log = path.join(dir, "execform-log.jsonl");
  await mkdir(dir, { recursive: true });

  const probe = path.join(dir, "probe-exec.mjs");
  await writeFile(
    probe,
    `import { appendFileSync } from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv: process.argv.slice(2),
  session_id: input.session_id,
  hasTranscript: typeof input.transcript_path === "string"
}) + "\\n");
`
  );

  // Text every shell would rewrite: $(…) is command substitution in bash and a
  // subexpression in PowerShell, and backticks substitute in both. Arriving
  // byte-for-byte is the proof that no shell sat between the host and node.
  const canary = "nc$(echo INJECTED)`echo INJECTED`end";
  await writeHookSettings(dir, {
    Stop: [{ hooks: [{ type: "command", command: "node", args: [probe, canary], timeout: 15 }] }]
  });

  await claude(["-p", "Reply with exactly: EXECOK"], { cwd: dir, env: cleanEnv() });

  const entries = await readJsonl(log);
  const first = entries[0] ?? {};
  record(
    "exec-form hook runs and still receives the Stop payload on stdin",
    typeof first.session_id === "string" && first.session_id.length > 0 && first.hasTranscript === true,
    entries.length > 0 ? `invocations=${entries.length}` : "hook never ran"
  );
  // argv is already sliced past node and the script, so the canary is its only
  // element — an extra one would mean a shell had split the argument.
  record(
    "exec-form args reach the process verbatim — no shell interpretation",
    Array.isArray(first.argv) && first.argv.length === 1 && first.argv[0] === canary,
    JSON.stringify(first.argv ?? null)
  );
}

// --- phase 5: the shipped manifest, installed as a real plugin -------------------

// Phases 1-4 wire the hook scripts by hand through project settings, which
// leaves the one thing only an install exercises untested: whether the host
// substitutes ${CLAUDE_PLUGIN_ROOT} inside `args`. If it did not, node would
// be handed a literal placeholder and the hook would silently never run —
// exactly the failure a hand-wired test cannot see.
async function findLiteContext(home, name) {
  const lite = path.join(home, "lite");
  for (const entry of await readdir(lite, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(lite, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch {
      // A malformed unrelated directory is not the bundle this phase created.
    }
  }
  return null;
}

async function readTextTree(directory) {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      text += await readTextTree(target);
    } else if (entry.isFile()) {
      text += `\n${await readFile(target, "utf8").catch(() => "")}`;
    }
  }
  return text;
}

async function installedPlugin(root) {
  const dir = path.join(root, "installed");
  const configDir = path.join(root, "installed-config");
  const market = path.join(root, "installed-market");
  const home = path.join(root, "installed-home");
  for (const target of [dir, configDir, home, path.join(market, ".claude-plugin")]) {
    await mkdir(target, { recursive: true });
  }

  // A copy, not the working tree: an install is what ships, and copying keeps
  // ${CLAUDE_PLUGIN_ROOT} pointing somewhere this phase owns and deletes.
  await cp(path.join(repo, "plugins", "claude-code", "neatcontext"), path.join(market, "neatcontext"), {
    recursive: true
  });
  await writeFile(
    path.join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "nc-e2e",
        owner: { name: "neatcontext e2e" },
        plugins: [{ name: "neatcontext", source: "./neatcontext", description: "e2e build under test" }]
      },
      null,
      2
    )
  );

  // A private config dir keeps this install away from the developer's own
  // plugins: same plugin name from a second marketplace would load twice.
  const env = cleanEnv({
    CLAUDE_CONFIG_DIR: configDir,
    NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json")
  });

  const added = await run("claude", ["plugin", "marketplace", "add", market], { cwd: dir, env });
  const installed = await run("claude", ["plugin", "install", "neatcontext@nc-e2e", "--scope", "user"], {
    cwd: dir,
    env
  });
  if (installed.code !== 0) {
    record("the shipped manifest installs as a plugin", false, (installed.err || added.err).trim().slice(-160));
    return;
  }

  const listed = await run("claude", ["plugin", "list"], { cwd: dir, env });
  const healthy =
    listed.code === 0 &&
    listed.out.includes("neatcontext@nc-e2e") &&
    /Status:\s+.*enabled/i.test(listed.out) &&
    !/failed to load|duplicate hooks/i.test(listed.out);
  record(
    "the installed plugin loads cleanly, including commands and MCP",
    healthy,
    healthy ? "status=enabled" : (listed.out || listed.err).trim().slice(-240)
  );
  if (!healthy) return;

  // A fresh config dir has no login. The token is copied in for the single
  // headless call below and shredded in the finally, whatever happens.
  const credentials = path.join(os.homedir(), ".claude", ".credentials.json");
  const scoped = path.join(configDir, ".credentials.json");
  const token = await readFile(credentials, "utf8").catch(() => null);
  if (token === null) {
    console.log(`SKIP  no ${credentials} to scope into the test config — run the installed-plugin phase on a logged-in machine`);
    return;
  }

  try {
    await writeFile(scoped, token, { mode: 0o600 });
    // Trust belongs in *this* config's project map, not the developer's.
    const configFile = path.join(configDir, ".claude.json");
    const config = JSON.parse(await readFile(configFile, "utf8").catch(() => "{}"));
    config.projects ??= {};
    for (const key of new Set([path.resolve(dir), realpathSync.native(dir), dir.replaceAll("\\", "/")])) {
      config.projects[key] = { ...config.projects[key], hasTrustDialogAccepted: true };
    }
    await writeFile(configFile, JSON.stringify(config, null, 2));

    const { out, err } = await run("claude", ["--model", "haiku", "-p", "Reply with exactly: PLUGINOK"], {
      cwd: dir,
      env
    });

    let routing = {};
    try {
      routing = JSON.parse(await readFile(path.join(home, "plugin-routing.json"), "utf8"));
    } catch {
      // Left empty: the assertion below reports what was missing.
    }
    const counted = Object.values(routing.sessions ?? {}).find((session) => session.save?.turns >= 1);
    record(
      "the installed plugin's Stop hook runs, so ${CLAUDE_PLUGIN_ROOT} resolved inside args",
      Boolean(counted) && counted.save.transcriptOffset > 0,
      counted
        ? `turns=${counted.save.turns} transcriptOffset=${counted.save.transcriptOffset}`
        : `no session state; model said ${JSON.stringify(out.trim().slice(-60))} ${err.trim().slice(-120)}`
    );

    // A real user path: produce durable work, then invoke the installed slash
    // command in the same session. The secret-shaped diagnostic belongs in the
    // source conversation only; neither evidence nor the saved context may
    // retain it.
    const saveSession = randomUUID();
    const contextName = "e2e-evidence-context";
    const secret = "sk-e2e-abcdefghijklmnopqrstuv";
    const seeded = await run(
      "claude",
      [
        "--model",
        "haiku",
        "--session-id",
        saveSession,
        "-p",
        `Durable decision: PAY-842 uses a maximum retry delay of 37 seconds because the provider rate-limits bursts. A diagnostic accidentally displayed API_KEY=${secret}; never write or preserve that value. Use the Write tool to create decision.md containing only the safe durable decision, then reply SEEDED.`,
        "--allowedTools",
        "Write"
      ],
      { cwd: dir, env, timeoutMs: 300_000 }
    );
    const saved = await run(
      "claude",
      [
        "--model",
        "haiku",
        // Print mode cannot answer an interactive tool approval prompt. This
        // process is confined to the disposable E2E config, home, and workspace.
        "--dangerously-skip-permissions",
        "-p",
        "--resume",
        saveSession,
        `/neatcontext:save ${contextName}`,
        "--allowedTools",
        "Read,Glob,Grep,Write,Bash"
      ],
      { cwd: dir, env, timeoutMs: 300_000 }
    );

    const saveRouting = JSON.parse(
      await readFile(path.join(home, "plugin-routing.json"), "utf8").catch(() => "{}")
    );
    const transcript = saveRouting.sessions?.[saveSession]?.save?.transcriptPath;
    const trace = typeof transcript === "string" ? await readJsonl(transcript).catch(() => []) : [];
    const evidenceInvoked = trace.some(
      (entry) =>
        entry.type === "assistant" &&
        entry.message?.content?.some?.(
          (part) =>
            part?.type === "tool_use" &&
            // Claude names the host shell tool Bash on POSIX and PowerShell on
            // Windows. The command itself is the portable contract here.
            /neatcontext-cli\.mjs["']?\s+evidence(?:\s|$)/i.test(String(part.input?.command ?? ""))
        )
    );
    record(
      "a real /neatcontext:save invokes the installed evidence projection",
      seeded.code === 0 && saved.code === 0 && evidenceInvoked,
      evidenceInvoked
        ? `session=${saveSession.slice(0, 8)}`
        : `seed=${seeded.code} save=${saved.code}; ${saved.out.trim().slice(-180)} ${saved.err.trim().slice(-120)}`
    );

    const bundle = await findLiteContext(home, contextName);
    const bundleText = bundle ? await readTextTree(bundle) : "";
    record(
      "the live save creates reusable knowledge with the durable decision",
      Boolean(bundle) && /PAY-842/.test(bundleText) && /37[- ]second|37 seconds/i.test(bundleText),
      bundle ? path.basename(bundle) : `no bundle; ${saved.out.trim().slice(-180)}`
    );

    const scratch = (await readdir(dir).catch(() => [])).filter((entry) =>
      entry.startsWith(".neatcontext-capture-")
    );
    record(
      "the live save omits the secret and consumes its capture scratch file",
      Boolean(bundle) && !bundleText.includes(secret) && scratch.length === 0,
      `secretPresent=${bundleText.includes(secret)} scratch=${JSON.stringify(scratch)}`
    );
  } finally {
    await rm(scoped, { force: true });
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
  if (!installedOnly) {
    for (const name of ["probe", "feature", "precompact", "execform"]) {
      const dir = path.join(root, name);
      await mkdir(dir, { recursive: true });
      await trustProject(dir);
    }
    await probeStopContract(root);
    await liveFeature(root);
    await probePreCompact(root);
    await probeExecForm(root);
  }
  await installedPlugin(root);
} finally {
  await untrustProjects();
  if (!keep) await rm(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
