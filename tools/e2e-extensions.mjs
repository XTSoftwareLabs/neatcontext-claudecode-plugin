// E2E: a context reaching a real system, on every host, with nothing installed.
//
// The unit and host tests each check one seam. This walks the whole thing the
// way a user does, once per host, against a real MCP server in a real child
// process:
//
//   1. a context declares an extension        -> nothing runs
//   2. the machine has no binding for it      -> reported, context still answers
//   3. the user writes a binding by hand      -> the tools appear
//   4. the session calls one                  -> proxied to the server
//   5. the session switches context           -> the tools are gone
//   6. the binding points somewhere broken    -> reported, context still answers
//
// Step 2 and step 6 are the ones worth having an E2E for: the feature has to be
// safe to leave half-configured, because most of the time it will be.
//
//   node tools/e2e-extensions.mjs

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "tests", "fake-extension-server.mjs");

const HOSTS = [
  {
    name: "Claude Code",
    dir: path.join(root, "plugins", "claude-code", "neatcontext", "src", "claude"),
    session: { CLAUDE_CODE_SESSION_ID: "e2e-extensions" }
  },
  {
    name: "Codex",
    dir: path.join(root, "codex-marketplace", "plugins", "neatcontext", "src", "codex"),
    session: { CODEX_THREAD_ID: "e2e-extensions" }
  },
  {
    name: "GitHub Copilot",
    dir: path.join(root, "plugins", "copilot", "neatcontext", "src", "copilot"),
    session: { NEATCONTEXT_SESSION_ID: "e2e-extensions" }
  },
  {
    name: "Kimi Code",
    dir: path.join(root, "plugins", "kimi-code", "neatcontext", "src", "kimi"),
    session: {},
    cliArgs: ["--session-id", "e2e-extensions"],
    bindSession: "e2e-extensions"
  }
];

let failures = 0;
let checks = 0;

function ok(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("close", () => resolve(out.trim()));
  });
}

function openBridge(file, env) {
  const child = spawn(process.execPath, [file], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  const queued = [];
  lines.on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.id === undefined) return;
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  let id = 0;
  return {
    send: async (method, params = {}) => {
      id += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return queued.length > 0
        ? queued.shift()
        : new Promise((resolve) => waiting.push(resolve));
    },
    stderr: () => stderr,
    close: async () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  };
}

async function exercise(host) {
  console.log(`\n=== ${host.name} ===`);
  const home = await mkdtemp(path.join(os.tmpdir(), "nc-e2e-ext-"));
  const docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");

  const env = { ...process.env, NEATCONTEXT_HOME: home, ...host.session };
  const cli = (...args) =>
    run(path.join(host.dir, "neatcontext-cli.mjs"), [...args, ...(host.cliArgs ?? [])], env);
  const bindings = path.join(home, "extensions.json");
  const write = (value) =>
    writeFile(
      bindings,
      `${JSON.stringify({ schema: 1, extensions: { pagerduty: value } }, null, 2)}\n`
    );

  const bridge = openBridge(path.join(host.dir, "mcp-bridge.mjs"), env);
  try {
    for (const name of ["Payments", "Checkout"]) {
      await cli(
        "create",
        "--name",
        name,
        "--knowledge",
        docs,
        "--profile",
        `# ${name}\n\n## Purpose\nWork.`
      );
    }
    await cli("use", "Payments");
    await bridge.send("initialize", { protocolVersion: "2025-11-25" });
    if (host.bindSession) {
      await bridge.send("tools/call", {
        name: "bind_session",
        arguments: { session_id: host.bindSession }
      });
    }

    const grounding = async () =>
      (await bridge.send("tools/call", { name: "get_context", arguments: {} })).result.content[0]
        .text;
    const toolNames = async () =>
      (await bridge.send("tools/list")).result.tools.map((tool) => tool.name);

    // 1. Declaring runs nothing.
    const declared = await cli(
      "extensions",
      "add",
      "pagerduty",
      "--capability",
      "Read incidents and on-call schedules.",
      "--tools",
      "get_incident",
      "--important"
    );
    ok("a declaration is recorded", /now expects the "pagerduty" extension/.test(declared), declared);
    ok("and says plainly that it connects nothing", /not a connection/.test(declared));

    // 2. Unconfigured is a reportable state, not a failure.
    const unconfigured = await cli("extensions");
    ok("an unbound extension is reported", /not configured on this machine/.test(unconfigured), unconfigured);
    ok("with the binding to paste and where it goes", /"command": "node"/.test(unconfigured) && /extensions\.json/.test(unconfigured));
    ok("and credentials are steered to the environment", /Put credentials in the environment/.test(unconfigured));
    ok("no tool is advertised for it", !(await toolNames()).some((name) => name.includes("__")));
    const degraded = await grounding();
    ok("the context still answers", /connected context: Payments/.test(degraded) && /runbook\.md/.test(degraded));
    ok("and names what it could not reach", /\(not configured on this machine\)/.test(degraded));

    // 3 & 4. A hand-written binding is what makes it real.
    await write({ command: process.execPath, args: [fakeServer] });
    ok("a bound extension reports ready", /pagerduty — ready/.test(await cli("extensions")));
    const names = await toolNames();
    ok("its declared tool is advertised", names.includes("pagerduty__get_incident"), names.join(", "));
    ok(
      "and only the declared one",
      !names.includes("pagerduty__search_incidents"),
      names.join(", ")
    );
    const called = await bridge.send("tools/call", {
      name: "pagerduty__get_incident",
      arguments: { query: "INC-1" }
    });
    ok(
      "a call reaches the real server",
      /get_incident ran with \{"query":"INC-1"\}/.test(called.result.content[0].text),
      JSON.stringify(called).slice(0, 200)
    );
    const ready = await grounding();
    ok("get_context says it is ready and how to call it", /\*\*pagerduty\*\* \(ready\)/.test(ready) && /pagerduty__get_incident/.test(ready));

    // 5. The capability belongs to the context.
    await cli("use", "Checkout");
    ok("switching context withdraws the tools", !(await toolNames()).some((name) => name.includes("__")));
    const refused = await bridge.send("tools/call", {
      name: "pagerduty__get_incident",
      arguments: {}
    });
    ok(
      "and calling one is refused",
      /is not available from the connected context/.test(refused.error?.message ?? ""),
      JSON.stringify(refused).slice(0, 200)
    );
    ok("with no extension section for a context that declares none", !/Extensions this context expects/.test(await grounding()));

    // 6. A broken binding degrades the same way a missing one does.
    await cli("use", "Payments");
    await write({ command: path.join(home, "definitely-not-a-program") });
    const broken = await cli("extensions");
    ok("a binding that cannot run is reported", /pagerduty — unavailable/.test(broken), broken);
    ok("with the reason", /could not start/.test(broken));
    const stillWorks = await grounding();
    ok("the context still answers", /connected context: Payments/.test(stillWorks) && /runbook\.md/.test(stillWorks));
    ok(
      "and the session is told to fall back",
      /Answer from the domain profile and the knowledge folder/.test(stillWorks)
    );

    ok("nothing was written to the host's error stream", bridge.stderr() === "", bridge.stderr().slice(0, 200));
  } finally {
    await bridge.close();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

for (const host of HOSTS) {
  await exercise(host);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
