// Regression tests for the reported failure: after `/clear`, `/neatcontext:use`
// reports the new context connected while `get_context` keeps answering from the
// previous one.
//
// The host process outlives the session. Claude Code starts a new session inside
// the same window and does not restart the MCP server, so the bridge keeps the
// session id it was spawned with while every slash command sees the new one. The
// two halves then read and write different files, and nothing in either path can
// notice.
//
// What is simulated here is exactly that and nothing else: one long-lived bridge
// process, slash commands spawned per command, and the SessionStart hook Claude
// Code runs when the session changes underneath them.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./process-helpers.mjs";

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-code",
  "neatcontext"
);
const claude = path.join(plugin, "src", "claude");

const HOST = "test-window";
const OTHER_HOST = "test-window-2";

let home;
let hostsDirectory;

const childEnv = (sessionId, host = HOST) => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: sessionId,
  // Stands in for the host process id the plugin keys on, so the test controls
  // which "window" each child belongs to.
  NEATCONTEXT_HOST_KEY: host,
  CLAUDE_PID: "",
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-session-drift-"));
  hostsDirectory = path.join(home, "plugin-hosts");
  const docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "payments.md"), "# Payments\n");
  // The contexts a session could connect. On disk once, like a user's: what the
  // tests vary is which session is connected to them, never the store itself.
  process.env.NEATCONTEXT_HOME = home;
  const store = await import("../plugins/claude-code/neatcontext/src/core/context-store.mjs");
  for (const name of ["payment team", "Dokploy"]) {
    await store.createContext({
      name,
      knowledgeFolder: docs,
      profile: `# ${name}\n\n## Purpose\nQuestions about ${name}.`
    });
  }
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(hostsDirectory, { recursive: true, force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

// A slash command: spawned per invocation, with the environment of the session
// the user is in right now.
function cli(sessionId, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(claude, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv(sessionId)
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// What Claude Code runs when a session starts — including the new one `/clear`
// creates in the window that is already open.
function sessionStart(sessionId, source = "clear", host = HOST) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(plugin, "hooks", "session-start.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv(sessionId, host)
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
    child.stdin.end(JSON.stringify({ session_id: sessionId, source, hook_event_name: "SessionStart" }));
  });
}

// A window: one bridge process kept alive across sessions, as Claude Code keeps
// it. `sessionId` is what it was spawned with, and is never updated afterwards —
// that is the whole point.
function openWindow(sessionId, host = HOST) {
  const child = spawn(process.execPath, [path.join(claude, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv(sessionId, host)
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
    pid: child.pid,
    notifications,
    send,
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      return response;
    },
    grounding: async () =>
      (await send("tools/call", { name: "get_context", arguments: {} })).result.content[0].text,
    close: () => closeSession(child)
  };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function writeBridgeRecord(sessionId, { pid = process.pid, host = HOST } = {}) {
  await mkdir(hostsDirectory, { recursive: true });
  await writeFile(
    path.join(hostsDirectory, `${host}.bridge.json`),
    JSON.stringify({ pid, sessionId, updatedAt: new Date().toISOString() })
  );
}

async function waitFor(predicate, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a session that is replaced under a running bridge", () => {
  it("stops serving the previous session's context", async () => {
    const window = openWindow("session-a");
    try {
      await window.handshake();
      await cli("session-a", "use", "payment", "team");
      assert.match(await window.grounding(), /connected context: payment team/);

      // `/clear`: a new session, the same window, the same bridge process.
      await sessionStart("session-b");

      const answer = await window.grounding();
      // "payment team" still appears in the routing menu, as one of the contexts
      // this session could connect. What must be gone is it being served.
      assert.doesNotMatch(answer, /connected context: payment team/);
      assert.match(answer, /No NeatContext Context is connected to this session/);
    } finally {
      await window.close();
    }
  });

  it("serves the context the new session connects", async () => {
    const window = openWindow("session-a");
    try {
      await window.handshake();
      await cli("session-a", "use", "payment", "team");
      await sessionStart("session-b");

      assert.match(await cli("session-b", "use", "Dokploy"), /Connected the "Dokploy" context/);
      assert.match(await window.grounding(), /connected context: Dokploy/);
    } finally {
      await window.close();
    }
  });

  it("tells the host its tool list changed, without being asked anything", async () => {
    const window = openWindow("session-a");
    try {
      await window.handshake();
      await cli("session-a", "use", "payment", "team");
      await window.grounding();
      window.notifications.length = 0;

      await sessionStart("session-b");

      const changed = await waitFor(async () =>
        window.notifications.some(
          (message) => message.method === "notifications/tools/list_changed"
        )
      );
      assert.ok(changed, "the bridge never announced that its tool list had changed");
    } finally {
      await window.close();
    }
  });

  it("leaves the other windows on the machine alone", async () => {
    const first = openWindow("session-a", HOST);
    const second = openWindow("other-session", OTHER_HOST);
    try {
      await first.handshake();
      await second.handshake();
      await cli("session-a", "use", "payment", "team");
      await cli("other-session", "use", "Dokploy");

      await sessionStart("session-b", "clear", HOST);

      assert.match(await first.grounding(), /No NeatContext Context is connected/);
      assert.match(await second.grounding(), /connected context: Dokploy/);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("says what `/clear` disconnected, so it does not just vanish", async () => {
    const window = openWindow("session-a");
    try {
      await window.handshake();
      await cli("session-a", "use", "payment", "team");

      const output = await sessionStart("session-b");
      const { hookSpecificOutput } = JSON.parse(output);
      assert.equal(hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(hookSpecificOutput.additionalContext, /"payment team"/);
      assert.match(hookSpecificOutput.additionalContext, /\/neatcontext:use payment team/);
    } finally {
      await window.close();
    }
  });

  it("says nothing at startup, when there is no previous session to report", async () => {
    assert.equal(await sessionStart("session-a", "startup"), "");
  });
});

describe("a bridge deciding which session it is on", () => {
  it("publishes what it resolved, so a slash command can check it", async () => {
    const window = openWindow("session-a");
    try {
      await window.handshake();
      const record = await readJson(path.join(hostsDirectory, `${HOST}.bridge.json`));
      assert.equal(record.sessionId, "session-a");
      assert.equal(record.pid, window.pid);
    } finally {
      await window.close();
    }
  });

  it("ignores a pointer left behind by an earlier host with the same key", async () => {
    // A pid is reused eventually. A record older than this process cannot be
    // describing a change that happened after it started.
    await mkdir(hostsDirectory, { recursive: true });
    await writeFile(
      path.join(hostsDirectory, `${HOST}.json`),
      JSON.stringify({
        sessionId: "long-gone-session",
        source: "stop",
        updatedAt: "2001-01-01T00:00:00.000Z"
      })
    );
    await cli("session-a", "use", "payment", "team");

    const window = openWindow("session-a");
    try {
      await window.handshake();
      assert.match(await window.grounding(), /connected context: payment team/);
    } finally {
      await window.close();
    }
  });
});

describe("what /neatcontext:use claims", () => {
  it("warns when the bridge has not picked this session up", async () => {
    // A bridge stuck on another session: the selection lands on disk and the
    // process that serves the session never reads it.
    await writeBridgeRecord("some-other-session");

    const output = await cli("session-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.match(output, /still serving an earlier session/);
  });

  it("stays quiet when the bridge is on the same session", async () => {
    await writeBridgeRecord("session-a");

    const output = await cli("session-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier session/);
  });

  it("stays quiet when no bridge is publishing anything to check against", async () => {
    const output = await cli("session-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier session/);
  });

  it("reports the drift from /neatcontext:status too", async () => {
    await cli("session-a", "use", "payment", "team");
    await writeBridgeRecord("some-other-session");

    const status = await cli("session-a", "status");
    assert.match(status, /serving an earlier session \(some-other-session\), not this one/);
    assert.match(status, /Connected context: payment team/);
  });

  it("ignores a record from a bridge that is no longer running", async () => {
    // Above Linux's pid ceiling and not a multiple of four, which Windows pids
    // are: no platform can have handed this one out.
    await writeBridgeRecord("some-other-session", { pid: 2147483647 });

    const output = await cli("session-a", "use", "payment", "team");
    assert.doesNotMatch(output, /still serving an earlier session/);
  });
});
