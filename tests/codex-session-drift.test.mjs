// Regression tests for thread drift in the Codex plugin: after `/new`,
// `$neatcontext:use` reports the new context connected while `get_context`
// keeps answering from the previous thread's one.
//
// The host process outlives the thread. Codex starts a new thread inside the
// same window and does not restart the MCP server, so the bridge keeps the
// `CODEX_THREAD_ID` it was spawned with while the SessionStart hook and the
// skill-run CLI see the new one. The two halves then read and write different
// files, and nothing in either path can notice.
//
// What is simulated here is exactly that and nothing else: one long-lived
// bridge process, CLI commands spawned per command, and the SessionStart hook
// Codex runs when the thread changes underneath them.

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
  "codex-marketplace",
  "plugins",
  "neatcontext"
);
const codex = path.join(plugin, "src", "codex");

const HOST = "codex-window";
const OTHER_HOST = "codex-window-2";

let home;
let hostsDirectory;

const childEnv = (threadId, host = HOST) => ({
  ...process.env,
  CODEX_THREAD_ID: threadId,
  // Stands in for the host process id the plugin keys on, so the test controls
  // which "window" each child belongs to.
  NEATCONTEXT_HOST_KEY: host,
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-drift-"));
  hostsDirectory = path.join(home, "plugin-hosts");
  const docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "payments.md"), "# Payments\n");
  // The contexts a thread could connect. On disk once, like a user's: what the
  // tests vary is which thread is connected to them, never the store itself.
  process.env.NEATCONTEXT_HOME = home;
  const store = await import(
    "../codex-marketplace/plugins/neatcontext/src/core/context-store.mjs"
  );
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

// A skill-run command: spawned per invocation, with the environment of the
// thread the user is in right now.
function cli(threadId, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(codex, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv(threadId)
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// What Codex runs when a thread starts — including the new one `/new` creates
// in the window that is already open.
function sessionStart(threadId, source = "clear", host = HOST) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(plugin, "hooks", "session-start.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv(threadId, host)
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
    child.stdin.end(
      JSON.stringify({ session_id: threadId, source, hook_event_name: "SessionStart" })
    );
  });
}

// A window: one bridge process kept alive across threads, as Codex keeps it.
// `threadId` is what it was spawned with, and is never updated afterwards —
// that is the whole point.
function openWindow(threadId, host = HOST) {
  const child = spawn(process.execPath, [path.join(codex, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv(threadId, host)
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

async function writeBridgeRecord(threadId, { pid = process.pid, host = HOST } = {}) {
  await mkdir(hostsDirectory, { recursive: true });
  await writeFile(
    path.join(hostsDirectory, `${host}.bridge.json`),
    JSON.stringify({ pid, sessionId: threadId, updatedAt: new Date().toISOString() })
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

describe("a thread that is replaced under a running Codex bridge", () => {
  it("stops serving the previous thread's context", async () => {
    const window = openWindow("thread-a");
    try {
      await window.handshake();
      await cli("thread-a", "use", "payment", "team");
      assert.match(await window.grounding(), /connected context: payment team/);

      // `/new`: a new thread, the same window, the same bridge process.
      await sessionStart("thread-b");

      const answer = await window.grounding();
      // "payment team" still appears in the routing menu, as one of the contexts
      // this thread could connect. What must be gone is it being served.
      assert.doesNotMatch(answer, /connected context: payment team/);
      assert.match(answer, /No NeatContext Context is selected for this thread/);
    } finally {
      await window.close();
    }
  });

  it("serves the context the new thread connects", async () => {
    const window = openWindow("thread-a");
    try {
      await window.handshake();
      await cli("thread-a", "use", "payment", "team");
      await sessionStart("thread-b");

      assert.match(await cli("thread-b", "use", "Dokploy"), /Connected the "Dokploy" context/);
      assert.match(await window.grounding(), /connected context: Dokploy/);
    } finally {
      await window.close();
    }
  });

  it("tells the host its tool list changed, without being asked anything", async () => {
    const window = openWindow("thread-a");
    try {
      await window.handshake();
      await cli("thread-a", "use", "payment", "team");
      await window.grounding();
      window.notifications.length = 0;

      await sessionStart("thread-b");

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
    const first = openWindow("thread-a", HOST);
    const second = openWindow("other-thread", OTHER_HOST);
    try {
      await first.handshake();
      await second.handshake();
      await cli("thread-a", "use", "payment", "team");
      await cli("other-thread", "use", "Dokploy");

      await sessionStart("thread-b", "clear", HOST);

      assert.match(await first.grounding(), /No NeatContext Context is selected/);
      assert.match(await second.grounding(), /connected context: Dokploy/);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("still emits its routing guidance after recording the thread", async () => {
    await cli("thread-a", "use", "payment", "team");

    const output = await sessionStart("thread-b");
    const { hookSpecificOutput } = JSON.parse(output);
    assert.equal(hookSpecificOutput.hookEventName, "SessionStart");
    // The new thread inherits no selection, and the guidance must say so.
    assert.match(hookSpecificOutput.additionalContext, /No NeatContext context is selected/);

    const pointer = await readJson(path.join(hostsDirectory, `${HOST}.json`));
    assert.equal(pointer.sessionId, "thread-b");
    assert.equal(pointer.source, "session-start");
  });
});

describe("a Codex bridge deciding which thread it is on", () => {
  it("publishes what it resolved, so a skill-run command can check it", async () => {
    const window = openWindow("thread-a");
    try {
      await window.handshake();
      const record = await readJson(path.join(hostsDirectory, `${HOST}.bridge.json`));
      assert.equal(record.sessionId, "thread-a");
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
        sessionId: "long-gone-thread",
        source: "session-start",
        updatedAt: "2001-01-01T00:00:00.000Z"
      })
    );
    await cli("thread-a", "use", "payment", "team");

    const window = openWindow("thread-a");
    try {
      await window.handshake();
      assert.match(await window.grounding(), /connected context: payment team/);
    } finally {
      await window.close();
    }
  });
});

describe("what $neatcontext:use claims", () => {
  it("warns when the bridge has not picked this thread up", async () => {
    // A bridge stuck on another thread: the selection lands on disk and the
    // process that serves the thread never reads it.
    await writeBridgeRecord("some-other-thread");

    const output = await cli("thread-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.match(output, /still serving an earlier thread/);
  });

  it("stays quiet when the bridge is on the same thread", async () => {
    await writeBridgeRecord("thread-a");

    const output = await cli("thread-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier thread/);
  });

  it("stays quiet when no bridge is publishing anything to check against", async () => {
    const output = await cli("thread-a", "use", "payment", "team");
    assert.match(output, /Connected the "payment team" context/);
    assert.doesNotMatch(output, /still serving an earlier thread/);
  });

  it("reports the drift from $neatcontext:status too", async () => {
    await cli("thread-a", "use", "payment", "team");
    await writeBridgeRecord("some-other-thread");

    const status = await cli("thread-a", "status");
    assert.match(status, /serving an earlier thread \(some-other-thread\), not this one/);
    assert.match(status, /Connected context: payment team/);
  });

  it("ignores a record from a bridge that is no longer running", async () => {
    // Above Linux's pid ceiling and not a multiple of four, which Windows pids
    // are: no platform can have handed this one out.
    await writeBridgeRecord("some-other-thread", { pid: 2147483647 });

    const output = await cli("thread-a", "use", "payment", "team");
    assert.doesNotMatch(output, /still serving an earlier thread/);
  });
});
