// Lite contexts are the plugin's own: created here, stored here, served here.
// The defining property these tests protect is that none of it needs the
// NeatContext desktop app — most cases below run with no companion at all.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  NEATCONTEXT_INSTRUCTIONS,
  ROUTING_TOOL_NAMES,
  closeSession,
  startFakeCompanion
} from "./fake-companion.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let home;
let discoveryFile;
let docs;

// Routing is per session, and these tests are not about it: an empty id pins
// them to the global mode, so they behave the same in CI (where Claude Code has
// set nothing) as under the Claude Code session that may be running them.
const childEnv = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "",
  NEATCONTEXT_COMPANION_FILE: discoveryFile
});

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
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
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

async function createContext(name, { folder = docs, profile = "# Payments\n\n## Purpose\nOwns billing.\n" } = {}) {
  const profileFile = path.join(home, `profile-${Math.random().toString(16).slice(2)}.md`);
  await writeFile(profileFile, profile);
  const output = await cli("create", "--name", name, "--knowledge", folder, "--profile-from", profileFile);
  await rm(profileFile, { force: true });
  return output;
}

// A stand-in for Claude Code: one bridge process kept alive across turns.
// `childEnv` matters here as much as it does for the CLI — inheriting the real
// CLAUDE_CODE_SESSION_ID would let the bridge pin a selection under the id of
// whatever session is *running the tests*, which then outlives beforeEach.
function openSession() {
  const child = spawn(process.execPath, [path.join(scripts, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv()
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
    // The tools that came from the connected context — routing tools belong to
    // no context and would only obscure what these assertions are about.
    contextToolNames: async () =>
      (await send("tools/list")).result.tools
        .map((tool) => tool.name)
        .filter((name) => !ROUTING_TOOL_NAMES.includes(name)),
    close: () => closeSession(child)
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
    assert.match(await cli("list", "--lite"), /Lite contexts:\s+\(none/);
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

describe("listing with no standard contexts", () => {
  it("explains where they are, in the section that is empty", async () => {
    await createContext("Payments Runbooks");
    const listed = await cli("list");

    assert.match(listed, /Standard contexts:\s+\(none — open the NeatContext desktop app/);
    assert.match(listed, /Lite contexts:\s+1\. Payments Runbooks/);
  });

  it("numbers the lite contexts from 1 when there are no standard ones", async () => {
    await createContext("Payments Runbooks");
    assert.match(await cli("use", "1"), /Connected the "Payments Runbooks" lite context/);
  });
});

// Session instructions are fetched once, at the handshake, and MCP cannot change
// them afterwards. The selection is on disk before the handshake, so the bridge
// already knows which source will serve the session — which is what makes a
// restart with a remembered context work without running /neatcontext:use.
describe("session instructions for a lite context", () => {
  it("frames the session itself, with NeatContext desktop absent", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /NeatContext Lite context/);
      assert.match(instructions, /Call the get_context tool before answering/);
      // The point of the whole change: no borrowed incident framing.
      assert.doesNotMatch(instructions, /incident/i);
    } finally {
      await session.close();
    }
  });

  it("takes effect on a restart that never runs /neatcontext:use", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    // A fresh host process, as if Claude Code had been restarted: the only thing
    // carried over is the selection file.
    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /NeatContext Lite context/);
      assert.match(contextText(await session.getContext()), /connected context: Payments Runbooks/);
    } finally {
      await session.close();
    }
  });

  it("tells a session with nothing connected how to get grounded", async () => {
    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /No NeatContext Context was connected at the moment/);
      assert.match(instructions, /\/neatcontext:create/);
    } finally {
      await session.close();
    }
  });

  // The reported failure: a session started while NeatContext was still coming
  // up answered "no context is currently connected" to everything, for its whole
  // life, without ever calling get_context — which by then would have returned a
  // perfectly good Context. Instructions are fixed at the handshake, so the only
  // fix is to never state the connection state there as a settled fact.
  it("does not let a handshake with nothing connected settle the question", async () => {
    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      // Defers to the tool instead of answering from this text.
      assert.match(instructions, /call the get_context tool and let its answer decide/);
      assert.match(instructions, /must not tell the user nothing is connected/);
      assert.match(instructions, /fixed at the handshake and cannot be updated/);
      // And never asserts the negative the session would otherwise repeat.
      assert.doesNotMatch(instructions, /there is nothing to ground answers in/);
    } finally {
      await session.close();
    }
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
      // Handshake framing cannot be changed mid-session, so this is the only
      // place left to disown an incident contract the session may be carrying.
      assert.match(text, /not an incident context unless the profile above says so/);
    } finally {
      await session.close();
    }
  });

  it("offers only get_context — no extension tools, no prompts", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.contextToolNames(), ["get_context"]);
      assert.deepEqual((await session.send("prompts/list")).result.prompts, []);
    } finally {
      await session.close();
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
      await session.close();
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
      await session.close();
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

// Plugin updates land while sessions are still running, so a bridge process
// holding the pre-lite code in memory can outlive one. That code reads every
// `contextId` as a NeatContext context, fails to restore a lite one, and treats
// the failure as "deleted upstream" by erasing the selection file — silently
// disconnecting a session that just connected.
describe("a lite selection and an older plugin process", () => {
  // The pre-lite reader, verbatim.
  function preLiteReadSelection(parsed) {
    if (typeof parsed?.contextId === "string" && parsed.contextId.trim().length > 0) {
      return {
        contextId: parsed.contextId,
        contextName: typeof parsed.contextName === "string" ? parsed.contextName : parsed.contextId
      };
    }
    return null;
  }

  it("is invisible to the pre-lite reader, so it has nothing to erase", async () => {
    await createContext("Payments Runbooks");
    await cli("use", "Payments");

    const written = JSON.parse(
      await readFile(path.join(home, "plugin-selection.json"), "utf8")
    );
    assert.equal(written.kind, "lite");
    assert.ok(written.liteContextId.startsWith("lite:"));
    // The load-bearing assertion: no `contextId` for old code to act on.
    assert.equal(written.contextId, undefined);
    assert.equal(preLiteReadSelection(written), null);
  });

  it("still reads a selection written by an earlier build of this feature", async () => {
    await createContext("Payments Runbooks");
    const id = /(lite:[a-z0-9-]+)/.exec(
      await readFile(
        path.join(home, "lite", (await readdir(path.join(home, "lite")))[0], "context.json"),
        "utf8"
      )
    )[1];
    await writeFile(
      path.join(home, "plugin-selection.json"),
      JSON.stringify({ kind: "lite", contextId: id, contextName: "Payments Runbooks" })
    );

    assert.match(await cli("status"), /Connected context: Payments Runbooks \(lite\)/);
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

  it("keeps NeatContext's own instructions for a standard context", async () => {
    await cli("use", "payment team");

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      // Forwarded intact, never rewritten: NeatContext owns the framing for its
      // own contexts, the plugin owns it for lite ones. The routing menu is
      // appended after it, and may not edit a word of what NeatContext said.
      assert.ok(instructions.startsWith(NEATCONTEXT_INSTRUCTIONS));
    } finally {
      await session.close();
    }
  });

  it("frames by the selection on disk, not by whether the app is running", async () => {
    await createContext("Payments Runbooks");

    await cli("use", "payment team");
    let session = openSession();
    try {
      assert.match((await session.handshake()).result.instructions, /incident investigation/);
    } finally {
      await session.close();
    }

    // Same machine, same running app — only the selection changed.
    await cli("use", "Payments Runbooks");
    session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /NeatContext Lite context/);
      assert.doesNotMatch(instructions, /incident/i);
    } finally {
      await session.close();
    }
  });

  it("lists the two kinds in their own sections", async () => {
    await createContext("Payments Runbooks");
    const listed = await cli("list");

    assert.match(listed, /Standard contexts:/);
    assert.match(listed, /Lite contexts:/);
    // A populated list explains nothing: the headings carry it.
    assert.doesNotMatch(listed, /NeatContext desktop app/);
    // The kind is the section, so rows no longer repeat it.
    assert.doesNotMatch(listed, /\(standard\)/);
    assert.doesNotMatch(listed, /\(lite\)/);
  });

  it("numbers continuously across both sections, so `use <n>` still works", async () => {
    await createContext("Payments Runbooks");
    const listed = await cli("list");

    // Two standard contexts from the fake companion, then the lite one.
    assert.match(listed, /1\. payment team/);
    assert.match(listed, /2\. Dokploy/);
    assert.match(listed, /3\. Payments Runbooks/);

    assert.match(await cli("use", "3"), /Connected the "Payments Runbooks" lite context/);
    assert.match(await cli("use", "1"), /Connected the "payment team" context/);
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
      assert.deepEqual(await session.contextToolNames(), ["get_context"]);

      await cli("use", "payment team");

      assert.deepEqual(await session.contextToolNames(), ["get_context", "demo_ctx_payments"]);
      assert.match(contextText(await session.getContext()), /Connected context: payment team/);
    } finally {
      await session.close();
    }
  });

  it("refuses to delete a standard context", async () => {
    const output = await cli("delete", "payment team");
    assert.match(output, /is a standard context/);
    assert.match(output, /NeatContext desktop app/);
    assert.deepEqual(companion.state.contexts.length, 2);
  });
});
