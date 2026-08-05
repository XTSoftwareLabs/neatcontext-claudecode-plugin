// The Claude Code surface for extensions: the CLI a slash command runs, and the
// MCP bridge the session talks to.
//
// Both are driven as Claude Code drives them — spawned processes, real stdio —
// against a real extension server, because the point of this feature is that
// something outside this repository answers.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "claude-code", "neatcontext");
const cliFile = path.join(plugin, "src", "claude", "neatcontext-cli.mjs");
const bridgeFile = path.join(plugin, "src", "claude", "mcp-bridge.mjs");
const fakeServer = path.join(root, "tests", "fake-extension-server.mjs");

let home;
let docs;

const env = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "extensions-test",
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-extensions-claude-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "extensions.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      env: env(),
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

function openBridge() {
  const child = spawn(process.execPath, [bridgeFile], {
    env: env(),
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
    const value = JSON.parse(line);
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

async function bind(extensions) {
  await writeFile(
    path.join(home, "extensions.json"),
    `${JSON.stringify({ schema: 1, extensions }, null, 2)}\n`
  );
}

const server = (env = {}) => ({ command: process.execPath, args: [fakeServer], env });

async function connectedContext(name = "Payments") {
  await cli(
    "create",
    "--name",
    name,
    "--knowledge",
    docs,
    "--profile",
    `# ${name}\n\n## Purpose\nPayment operations.`
  );
  await cli("use", name);
}

describe("the extensions command", () => {
  it("says nothing is connected before a context is", async () => {
    const output = await cli("extensions");
    assert.match(output, /No context is connected to this session/);
    assert.match(output, /extensions belong to a context, not to the machine/);
    assert.match(await cli("extensions", "add", "pagerduty"), /nothing to change/);
  });

  it("declares an extension without connecting anything", async () => {
    await connectedContext();
    const added = await cli(
      "extensions",
      "add",
      "pagerduty",
      "--capability",
      "Read incidents and on-call schedules.",
      "--tools",
      "get_incident,search_incidents",
      "--important"
    );
    assert.match(added, /now expects the "pagerduty" extension/);
    assert.match(added, /Capability: Read incidents and on-call schedules\./);
    assert.match(added, /Tools:      get_incident, search_incidents/);
    assert.match(added, /That is a declaration, not a connection/);

    // It is on the manifest, and it is only the portable half.
    const [contextDirectory] = await readdir(path.join(home, "contexts"));
    const manifest = JSON.parse(
      await readFile(path.join(home, "contexts", contextDirectory, "context.json"), "utf8")
    );
    assert.deepEqual(manifest.extensions, [
      {
        id: "pagerduty",
        capability: "Read incidents and on-call schedules.",
        importance: "important",
        tools: ["get_incident", "search_incidents"]
      }
    ]);

    // And status names it without starting it.
    assert.match(await cli("status"), /Extensions:       pagerduty/);
  });

  it("reports an unconfigured extension with the binding it wants", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    const status = await cli("extensions");
    assert.match(status, /pagerduty — not configured on this machine/);
    assert.match(status, /No local binding for "pagerduty"/);
    assert.match(status, /"command": "node"/);
    assert.match(status, /"envFrom": \["THE_API_TOKEN"\]/);
    assert.match(status, /Put credentials in the environment/);
    assert.match(status, /its profile and knowledge folder are served whether or not/);
  });

  it("reports a bound extension and the tools it offers", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.", "--important");
    await bind({ pagerduty: server() });
    const status = await cli("extensions");
    assert.match(status, /pagerduty — ready \(important to this context\)/);
    assert.match(status, /Tools:      pagerduty__search_incidents, pagerduty__get_incident/);

    const tested = await cli("extensions", "test", "pagerduty");
    assert.match(tested, /^pagerduty: ready/m);
    assert.match(tested, /Tools this context can call: pagerduty__search_incidents/);
  });

  it("reports a binding this machine cannot run", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    await bind({ pagerduty: { command: path.join(home, "not-a-program") } });
    const status = await cli("extensions");
    assert.match(status, /pagerduty — unavailable/);
    assert.match(status, /could not start/);
  });

  it("tests an extension this machine has not bound", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    const tested = await cli("extensions", "test", "pagerduty");
    assert.match(tested, /^pagerduty: not configured on this machine/m);
    assert.match(tested, /No local binding for "pagerduty"/);
    assert.match(tested, /Add it to .*extensions\.json/);
    assert.match(tested, /"command": "node"/);
  });

  it("reports a bindings file it cannot use", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    await bind({ pagerduty: { command: "" }, "": { command: "node" } });
    const status = await cli("extensions");
    assert.match(status, /Problems in .*extensions\.json/);
    assert.match(status, /needs a "command"/);
  });

  it("refuses input it cannot make into a declaration", async () => {
    await connectedContext();
    assert.match(await cli("extensions", "add", "pagerduty"), /Use: extensions add <id>/);
    assert.match(
      await cli("extensions", "add", "Has Space", "--capability", "x"),
      /not a usable extension id/
    );
    assert.match(await cli("extensions", "remove"), /Use: extensions remove <id>/);
    assert.match(await cli("extensions", "test"), /Use: extensions test <id>/);
    assert.match(
      await cli("extensions", "remove", "pagerduty"),
      /does not declare an extension "pagerduty"/
    );
    assert.match(await cli("extensions", "test", "pagerduty"), /does not declare an extension/);
    assert.match(await cli("extensions", "wat"), /Unknown extensions action "wat"/);
  });

  it("removes a declaration and leaves the local binding alone", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    await bind({ pagerduty: server() });
    const removed = await cli("extensions", "remove", "pagerduty");
    assert.match(removed, /no longer expects "pagerduty"/);
    assert.match(removed, /local binding for it, if there is one, was not touched/);
    assert.match(await cli("extensions"), /\(none declared\)/);
    assert.ok(JSON.parse(await readFile(path.join(home, "extensions.json"), "utf8")).extensions.pagerduty);
  });
});

describe("the extension surface a session sees", () => {
  it("offers the declared tools beside get_context and proxies a call", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.", "--tools", "get_incident");
    await bind({ pagerduty: server() });

    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const listed = await bridge.send("tools/list");
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes("get_context"));
      assert.ok(names.includes("pagerduty__get_incident"));
      assert.equal(names.includes("pagerduty__search_incidents"), false);

      const proxied = await bridge.send("tools/call", {
        name: "pagerduty__get_incident",
        arguments: { query: "INC-1" }
      });
      assert.match(proxied.result.content[0].text, /get_incident ran with \{"query":"INC-1"\}/);

      const grounding = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      const text = grounding.result.content[0].text;
      assert.match(text, /## Extensions this context expects/);
      assert.match(text, /\*\*pagerduty\*\* \(ready\)/);
      assert.match(text, /Call it with: pagerduty__get_incident/);
      assert.match(text, /not available once you switch away from it/);
      // The extension's stdio never reaches the host's.
      assert.equal(bridge.stderr(), "");
    } finally {
      await bridge.close();
    }
  });

  it("serves the context and says what is missing when nothing is bound", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");

    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const listed = await bridge.send("tools/list");
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name).filter((name) => name.includes("__")),
        []
      );
      const grounding = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      const text = grounding.result.content[0].text;
      // The grounding itself is unaffected.
      assert.match(text, /connected context: Payments/);
      assert.match(text, /runbook\.md/);
      assert.match(text, /\(not configured on this machine\)/);
      assert.match(text, /None of them are available right now/);

      const refused = await bridge.send("tools/call", {
        name: "pagerduty__get_incident",
        arguments: {}
      });
      assert.match(refused.error.message, /is not available from the connected context/);
    } finally {
      await bridge.close();
    }
  });

  it("stops offering an extension once the session leaves its context", async () => {
    await connectedContext("Payments");
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    await bind({ pagerduty: server() });
    await cli(
      "create",
      "--name",
      "Checkout",
      "--knowledge",
      docs,
      "--profile",
      "# Checkout\n\n## Purpose\nRetries."
    );

    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const before = await bridge.send("tools/list");
      assert.ok(before.result.tools.some((tool) => tool.name === "pagerduty__get_incident"));

      await cli("use", "Checkout");

      const after = await bridge.send("tools/list");
      assert.equal(
        after.result.tools.some((tool) => tool.name.includes("__")),
        false
      );
      const refused = await bridge.send("tools/call", {
        name: "pagerduty__get_incident",
        arguments: {}
      });
      assert.match(refused.error.message, /is not available from the connected context/);

      const grounding = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      assert.doesNotMatch(grounding.result.content[0].text, /Extensions this context expects/);
    } finally {
      await bridge.close();
    }
  });

  it("keeps an unknown tool name reading the way it always did", async () => {
    await connectedContext();
    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const unknown = await bridge.send("tools/call", { name: "whatever", arguments: {} });
      assert.match(unknown.error.message, /Contexts serve only get_context/);
    } finally {
      await bridge.close();
    }
  });

  it("tells the session when a call fails rather than failing the turn", async () => {
    await connectedContext();
    await cli("extensions", "add", "pagerduty", "--capability", "Read incidents.");
    await bind({ pagerduty: server({ FAKE_MCP_ERROR_TOOL: "get_incident" }) });

    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      await bridge.send("tools/list");
      const failed = await bridge.send("tools/call", {
        name: "pagerduty__get_incident",
        arguments: {}
      });
      assert.equal(failed.result.isError, true);
      assert.match(failed.result.content[0].text, /failed while serving pagerduty__get_incident/);
      assert.match(
        failed.result.content[0].text,
        /answer from the context's profile and knowledge instead/
      );

      // And the context still answers.
      const grounding = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      assert.match(grounding.result.content[0].text, /connected context: Payments/);
    } finally {
      await bridge.close();
    }
  });
});
