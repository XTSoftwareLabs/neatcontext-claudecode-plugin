// Lite contexts are the plugin's own: created here, stored here, served here.
// The defining property these tests protect is that none of it needs the
// NeatContext desktop app — most cases below run with no companion at all.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { startFakeCompanion } from "./fake-companion.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let home;
let discoveryFile;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-lite-test-"));
  // Nothing writes this file: the app is simply not running.
  discoveryFile = path.join(home, "companion.json");
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");
  await mkdir(path.join(docs, "tsg"), { recursive: true });
  await writeFile(path.join(docs, "tsg", "latency.md"), "# Latency TSG\n");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, NEATCONTEXT_COMPANION_FILE: discoveryFile }
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

async function createContext(name, { folder = docs, profile = "# Payments\n\n## Purpose\nOwns billing.\n" } = {}) {
  const profileFile = path.join(home, `profile-${Math.random().toString(16).slice(2)}.md`);
  await writeFile(profileFile, profile);
  const output = await cli("create", "--name", name, "--knowledge", folder, "--profile-from", profileFile);
  await rm(profileFile, { force: true });
  return output;
}

// A stand-in for Claude Code: one bridge process kept alive across turns.
function openSession() {
  const child = spawn(process.execPath, [path.join(scripts, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, NEATCONTEXT_COMPANION_FILE: discoveryFile }
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
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
    getContext: () => send("tools/call", { name: "get_context", arguments: {} }),
    toolNames: async () => (await send("tools/list")).result.tools.map((tool) => tool.name),
    close: () => child.kill()
  };
}

const contextText = (response) => response.result.content[0].text;

describe("creating a lite context", () => {
  it("stores it and prints the command to connect it", async () => {
    const output = await createContext("Payments Runbooks");
    assert.match(output, /Created the "Payments Runbooks" lite context/);
    assert.match(output, /Connect it with:\s+\/neatcontext:use Payments Runbooks/);
    // Created, not connected: connecting is the user's next explicit step.
    assert.match(await cli("status"), /No context is connected yet/);
  });

  it("keeps the profile as a plain file the user can edit by hand", async () => {
    await createContext("Payments Runbooks", { profile: "# Payments\n\n## Purpose\nOwns billing.\n" });
    await cli("use", "Payments");

    const profilePath = /Domain profile:\s+(.+)/.exec(await cli("status"))[1];
    assert.equal(await readFile(profilePath, "utf8"), "# Payments\n\n## Purpose\nOwns billing.\n");
  });

  it("refuses a knowledge folder that does not exist", async () => {
    const output = await createContext("Ghost", { folder: path.join(home, "nope") });
    assert.match(output, /No folder at/);
    assert.match(await cli("list", "--lite"), /no lite contexts/);
  });

  it("refuses an empty profile", async () => {
    const output = await createContext("Blank", { profile: "   \n" });
    assert.match(output, /profile is empty/);
  });

  it("refuses a duplicate name", async () => {
    await createContext("Payments Runbooks");
    const output = await createContext("Payments Runbooks");
    assert.match(output, /already exists/);
  });
});

describe("a session grounded in a lite context", () => {
  it("serves get_context with NeatContext desktop absent", async () => {
    await createContext("Payments Runbooks");
    assert.match(await cli("use", "Payments"), /Connected the "Payments Runbooks" lite context/);

    const session = openSession();
    try {
      await session.handshake();
      const text = contextText(await session.getContext());
      assert.match(text, /connected context: Payments Runbooks/);
      // Pointers, not content — the same contract a standard context serves.
      assert.match(text, /profile\.md/);
      assert.match(text, /Local knowledge folder/);
      // The folder listing is what makes one-folder lite searchable.
      assert.match(text, /runbook\.md/);
      assert.match(text, /tsg\/latency\.md/);
    } finally {
      session.close();
    }
  });

  it("offers only get_context — no extension tools, no prompts", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.toolNames(), ["get_context"]);
      assert.deepEqual((await session.send("prompts/list")).result.prompts, []);
    } finally {
      session.close();
    }
  });

  it("says so when the knowledge folder has gone missing", async () => {
    const folder = path.join(home, "temporary-docs");
    await mkdir(folder, { recursive: true });
    await createContext("Vanishing", { folder });
    await cli("use", "Vanishing");
    await rm(folder, { recursive: true, force: true });

    const session = openSession();
    try {
      await session.handshake();
      assert.match(contextText(await session.getContext()), /knowledge folder for this context .* is missing/s);
    } finally {
      session.close();
    }
  });

  it("says so when the context is removed from disk mid-session", async () => {
    // Not `delete`, which clears the selection too: this is the user wiping the
    // folder outside the plugin, leaving a selection pointing at nothing.
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const session = openSession();
    try {
      await session.handshake();
      assert.match(contextText(await session.getContext()), /connected context: Payments Runbooks/);

      await rm(path.join(home, "lite"), { recursive: true, force: true });

      assert.match(contextText(await session.getContext()), /no longer exists on disk/);
    } finally {
      session.close();
    }
  });

  it("reports the lite context from status", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const status = await cli("status");
    assert.match(status, /Connected context: Payments Runbooks \(lite\)/);
    assert.match(status, /Knowledge folder: .*docs \(2 files\)/);
    assert.match(status, /no extension tools/);
  });
});

describe("deleting a lite context", () => {
  it("asks for confirmation before removing anything", async () => {
    await createContext("Payments Runbooks");
    const preview = await cli("delete", "Payments");
    assert.match(preview, /Re-run with --yes to confirm/);
    assert.match(await cli("list", "--lite"), /Payments Runbooks/);
  });

  it("leaves the user's knowledge folder untouched", async () => {
    await createContext("Payments Runbooks");
    const output = await cli("delete", "Payments", "--yes");

    assert.match(output, /Deleted the "Payments Runbooks" lite context/);
    assert.match(output, /left untouched/);
    // The docs are the user's, and the plugin only ever held a path to them.
    assert.equal(await readFile(path.join(docs, "runbook.md"), "utf8"), "# Restart the worker\n");
  });

  it("ungrounds the session when the connected context is deleted", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const output = await cli("delete", "Payments", "--yes");
    assert.match(output, /no longer grounded/);
    assert.match(await cli("status"), /No context is connected yet/);
  });
});

describe("lite and standard side by side", () => {
  let companion;

  before(async () => {
    companion = await startFakeCompanion();
    // Both kinds share one home, the directory holding the discovery file.
    await writeFile(discoveryFile, await readFile(companion.discoveryFile, "utf8"));
  });
  after(async () => {
    await companion.stop();
    await rm(companion.directory, { recursive: true, force: true });
    await rm(discoveryFile, { force: true });
  });
  beforeEach(() => {
    companion.state.connected = null;
    companion.state.version = 0;
  });

  it("lists both kinds, labelled, in one numbered list", async () => {
    await createContext("Payments Runbooks");
    const listed = await cli("list");

    assert.match(listed, /1\. payment team\s+\(standard\)/);
    assert.match(listed, /3\. Payments Runbooks\s+\(lite\)/);
  });

  it("drops the app's connection when a lite context is selected", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "payment team");
    assert.ok(companion.state.connected);

    await cli("use", "Payments Runbooks");

    // Leaving the app bound to a standard context would make the two sources
    // disagree about what this session is grounded in.
    assert.equal(companion.state.connected, null);
    assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
  });

  it("never asks the app to restore a lite selection", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments Runbooks");
    const putsBefore = companion.state.puts;

    await cli("status");
    await cli("list");

    // A lite id means nothing to NeatContext: a restore attempt would 404 and
    // discard a perfectly good selection.
    assert.equal(companion.state.puts, putsBefore);
    assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
  });

  it("switches a live session from lite back to standard", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments Runbooks");

    const session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.toolNames(), ["get_context"]);

      await cli("use", "payment team");

      assert.deepEqual(await session.toolNames(), ["get_context", "demo_ctx_payments"]);
      assert.match(contextText(await session.getContext()), /Connected context: payment team/);
    } finally {
      session.close();
    }
  });

  it("refuses to delete a standard context", async () => {
    const output = await cli("delete", "payment team");
    assert.match(output, /is a standard context/);
    assert.match(output, /NeatContext desktop app/);
    assert.deepEqual(companion.state.contexts.length, 2);
  });
});
