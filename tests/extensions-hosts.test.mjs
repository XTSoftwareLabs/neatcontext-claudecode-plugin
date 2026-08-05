// The extension surface, host by host.
//
// Storage, declarations and bindings are host-neutral and tested once elsewhere.
// What this file checks is that every bridge actually wires them the same way:
// the same tools advertised, the same proxying, the same status inside
// get_context, and the same refusal once the session leaves the context.
//
// Each host is driven the way its own host drives it — Codex with a thread id,
// Copilot with a workspace session, Kimi through bind_session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "tests", "fake-extension-server.mjs");

const HOSTS = [
  {
    name: "Claude Code",
    dir: path.join(root, "plugins", "claude-code", "neatcontext", "src", "claude"),
    session: { CLAUDE_CODE_SESSION_ID: "extension-host-test" }
  },
  {
    name: "Codex",
    dir: path.join(root, "codex-marketplace", "plugins", "neatcontext", "src", "codex"),
    session: { CODEX_THREAD_ID: "extension-host-test" }
  },
  {
    name: "GitHub Copilot",
    dir: path.join(root, "plugins", "copilot", "neatcontext", "src", "copilot"),
    session: { NEATCONTEXT_SESSION_ID: "extension-host-test" }
  },
  {
    name: "Kimi Code",
    dir: path.join(root, "plugins", "kimi-code", "neatcontext", "src", "kimi"),
    session: {},
    cliArgs: ["--session-id", "extension-host-test"],
    bindSession: "extension-host-test"
  }
];

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
  child.stderr.resume();
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
    close: async () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  };
}

for (const host of HOSTS) {
  describe(`${host.name} serves a context's extensions`, () => {
    it("declares, advertises, proxies, and stops at the context boundary", async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-ext-host-"));
      const docs = path.join(home, "docs");
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");

      const env = { ...process.env, NEATCONTEXT_HOME: home, ...host.session };
      const cliFile = path.join(host.dir, "neatcontext-cli.mjs");
      const bridgeFile = path.join(host.dir, "mcp-bridge.mjs");
      const cli = (...args) => run(cliFile, [...args, ...(host.cliArgs ?? [])], env);

      const bridge = openBridge(bridgeFile, env);
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

        // Declaring names a capability; it connects nothing.
        const added = await cli(
          "extensions",
          "add",
          "pagerduty",
          "--capability",
          "Read incidents.",
          "--tools",
          "get_incident"
        );
        assert.match(added, /now expects the "pagerduty" extension/, host.name);
        assert.match(await cli("extensions"), /not configured on this machine/, host.name);
        assert.match(await cli("status"), /Extensions:       pagerduty/, host.name);

        // Binding it here is what makes it real.
        await writeFile(
          path.join(home, "extensions.json"),
          `${JSON.stringify(
            { schema: 1, extensions: { pagerduty: { command: process.execPath, args: [fakeServer] } } },
            null,
            2
          )}\n`
        );
        assert.match(await cli("extensions"), /pagerduty — ready/, host.name);

        await bridge.send("initialize", { protocolVersion: "2025-11-25" });
        if (host.bindSession) {
          await bridge.send("tools/call", {
            name: "bind_session",
            arguments: { session_id: host.bindSession }
          });
        }

        const listed = await bridge.send("tools/list");
        const names = listed.result.tools.map((tool) => tool.name);
        assert.ok(names.includes("get_context"), `${host.name}: ${names.join(", ")}`);
        assert.ok(names.includes("pagerduty__get_incident"), `${host.name}: ${names.join(", ")}`);
        assert.equal(
          names.includes("pagerduty__search_incidents"),
          false,
          `${host.name} advertises a tool the context did not declare`
        );

        const proxied = await bridge.send("tools/call", {
          name: "pagerduty__get_incident",
          arguments: { query: "INC-1" }
        });
        assert.match(proxied.result.content[0].text, /get_incident ran with/, host.name);

        const grounding = await bridge.send("tools/call", { name: "get_context", arguments: {} });
        assert.match(
          grounding.result.content[0].text,
          /## Extensions this context expects/,
          host.name
        );
        assert.match(grounding.result.content[0].text, /\*\*pagerduty\*\* \(ready\)/, host.name);

        // Leaving the context takes its extensions with it.
        await cli("use", "Checkout");
        const after = await bridge.send("tools/list");
        assert.equal(
          after.result.tools.some((tool) => tool.name.includes("__")),
          false,
          `${host.name} kept a tool from a context the session has left`
        );
        const refused = await bridge.send("tools/call", {
          name: "pagerduty__get_incident",
          arguments: {}
        });
        assert.match(
          refused.error.message,
          /is not available from the connected context/,
          host.name
        );
      } finally {
        await bridge.close();
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });
}
