// Regression tests for the reported failure: `/neatcontext:use payment team`
// reports success, then a later question answers "no NeatContext context is
// connected" because NeatContext was restarted in between and its connection
// lives only in memory.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  NO_CONTEXT_TEXT,
  ROUTING_TOOL_NAMES,
  closeSession,
  startFakeCompanion
} from "./fake-companion.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
let companion;

// Routing is per session, and these tests are not about it: an empty id pins
// them to the global mode, so they behave the same in CI (where Claude Code has
// set nothing) as under the Claude Code session that may be running them.
const childEnv = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "",
  NEATCONTEXT_COMPANION_FILE: companion.discoveryFile
});

before(async () => {
  companion = await startFakeCompanion();
});
after(async () => {
  await companion.stop();
  await rm(companion.directory, { recursive: true, force: true });
});
beforeEach(async () => {
  companion.state.connected = null;
  companion.state.lastRuntimeContext = null;
  companion.state.version = 0;
  companion.state.puts = 0;
  await rm(path.join(companion.directory, "plugin-selection.json"), { force: true });
  await rm(path.join(companion.directory, "plugin-routing.json"), { force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv()
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// A stand-in for Claude Code: keeps one bridge process alive across turns.
function openSession() {
  const child = spawn(process.execPath, [path.join(scripts, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv()
  });
  const waiters = new Map();
  const notifications = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    } else {
      notifications.push(message);
    }
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    notifications,
    send,
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return response;
    },
    getContext: () => send("tools/call", { name: "get_context", arguments: {} }),
    toolNames: async () => (await send("tools/list")).result.tools.map((tool) => tool.name),
    // The tools that came from the connected context, which is what every
    // assertion below is actually about.
    contextToolNames: async () =>
      (await send("tools/list")).result.tools
        .map((tool) => tool.name)
        .filter((name) => !ROUTING_TOOL_NAMES.includes(name)),
    close: () => closeSession(child)
  };
}

const contextText = (response) => response.result.content[0].text;

describe("a session keeps its context when NeatContext restarts", () => {
  it("reconnects the remembered context instead of answering 'no context'", async () => {
    const session = openSession();
    try {
      await session.handshake();
      assert.match(await cli("use", "payment", "team"), /Connected the "payment team" context/);
      assert.match(contextText(await session.getContext()), /Connected context: payment team/);

      companion.restart();

      assert.match(contextText(await session.getContext()), /Connected context: payment team/);
      assert.deepEqual(companion.state.connected, {
        contextId: "ctx-payments",
        contextName: "payment team"
      });
    } finally {
      await session.close();
    }
  });

  it("keeps the extension tools available after the restart", async () => {
    const session = openSession();
    try {
      await session.handshake();
      await cli("use", "payment", "team");
      assert.deepEqual(await session.contextToolNames(), ["get_context", "demo_ctx_payments"]);

      companion.restart();

      assert.deepEqual(await session.contextToolNames(), ["get_context", "demo_ctx_payments"]);
    } finally {
      await session.close();
    }
  });

  it("reconnects a session whose bridge process was restarted", async () => {
    await cli("use", "payment", "team");
    companion.restart();

    const session = openSession();
    try {
      await session.handshake();
      assert.match(contextText(await session.getContext()), /Connected context: payment team/);
    } finally {
      await session.close();
    }
  });

  it("is grounded from the handshake, before the host asks for anything", async () => {
    // Restarting the host with a context already remembered must reconnect it
    // during the handshake, so the first tools/list carries the extension tools
    // rather than depending on which message the host happens to send first.
    await cli("use", "payment", "team");
    companion.restart();

    const session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(companion.state.connected, {
        contextId: "ctx-payments",
        contextName: "payment team"
      });
      assert.deepEqual(await session.contextToolNames(), ["get_context", "demo_ctx_payments"]);
    } finally {
      await session.close();
    }
  });

  it("reports the restored context from /neatcontext:status", async () => {
    await cli("use", "payment", "team");
    companion.restart();

    const status = await cli("status");
    assert.match(status, /Connected context: payment team \(standard; NeatContext had restarted/);
  });

  it("marks the restored context as connected in /neatcontext:list", async () => {
    await cli("use", "payment", "team");
    companion.restart();

    assert.match(await cli("list"), /Standard contexts.*\n.*payment team\s+\(connected\)/);
  });
});

// A context here is whatever the user made it, so an incident-shaped slash
// command in the menu misrepresents what is connected.
describe("the analyze_incident prompt", () => {
  it("is not offered, while NeatContext's other prompts are", async () => {
    await cli("use", "payment", "team");

    const session = openSession();
    try {
      await session.handshake();
      const names = (await session.send("prompts/list")).result.prompts.map(
        (prompt) => prompt.name
      );
      assert.deepEqual(names, ["summarize_context"]);
    } finally {
      await session.close();
    }
  });

  it("answers as unknown if asked for by name", async () => {
    await cli("use", "payment", "team");

    const session = openSession();
    try {
      await session.handshake();
      const response = await session.send("prompts/get", { name: "analyze_incident" });
      assert.equal(response.result, undefined);
      assert.match(response.error.message, /Unknown prompt: analyze_incident/);
    } finally {
      await session.close();
    }
  });
});

describe("a session that never picked a context", () => {
  it("does not invent a connection", async () => {
    const session = openSession();
    try {
      await session.handshake();
      assert.match(contextText(await session.getContext()), new RegExp(NO_CONTEXT_TEXT.slice(0, 40)));
      assert.equal(companion.state.puts, 0);
    } finally {
      await session.close();
    }
  });

  it("hides the previous context's extension tools while nothing is connected", async () => {
    // NeatContext still advertises them: its runtime file outlives the
    // connection. Showing them tells the session it is grounded when it is not.
    companion.state.lastRuntimeContext = { id: "ctx-payments", name: "payment team" };

    const session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.contextToolNames(), ["get_context"]);
    } finally {
      await session.close();
    }
  });
});

describe("a context that no longer exists", () => {
  it("stops trying to restore it and says so", async () => {
    await cli("use", "payment", "team");
    companion.restart();
    companion.state.contexts = companion.state.contexts.filter(
      (context) => context.id !== "ctx-payments"
    );

    const status = await cli("status");
    assert.match(status, /no longer available in NeatContext/);

    companion.state.contexts = [
      { id: "ctx-payments", name: "payment team" },
      { id: "ctx-dokploy", name: "Dokploy" }
    ];
    // The forgotten selection is not silently resurrected on the next check.
    assert.match(await cli("status"), /No context is connected yet/);
  });
});
