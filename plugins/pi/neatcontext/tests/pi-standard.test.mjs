// Standard contexts: the half that comes from the NeatContext desktop app.
//
// pi has no MCP, so this runtime drives the app's MCP surface itself over the
// documented companion HTTP contract — including the handshake the other hosts
// get for free by relaying the agent's own. These tests use the same fake
// companion the Claude Code suite does, so both hosts are held to one contract.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { startFakeCompanion } from "../../../../tests/fake-companion.mjs";

let companion;
let home;
let runtime;
let session;

before(async () => {
  companion = await startFakeCompanion();
  home = companion.directory;
  process.env.NEATCONTEXT_COMPANION_FILE = companion.discoveryFile;
  runtime = await import("../src/pi/runtime.mjs");
  session = await import("../src/pi/session.mjs");
});

after(async () => {
  await companion.stop();
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  companion.restart();
  session.bindPiSessionId("pi-standard-session");
});

describe("standard contexts", () => {
  it("lists what the app serves alongside the lite ones", async () => {
    const list = await runtime.commandList();
    assert.match(list, /Standard contexts:/);
    assert.match(list, /payment team/);
    assert.match(list, /Dokploy/);
  });

  it("connects one and grounds the session in what the app returns", async () => {
    assert.match(await runtime.commandUse("payment team"), /Connected the "payment team" context/);
    assert.match(await runtime.commandStatus(), /Connected context: payment team \(standard\)/);

    const context = await runtime.getContext();
    assert.match(context, /Connected context: payment team/);
    assert.match(context, /## Connecting a context, in pi/);
  });

  it("never forwards the app's own reconnect advice", async () => {
    // The app answers "open NeatContext and click Connect" when it holds no
    // connection — true of its desktop client, useless from inside pi. The
    // plugin answers this case itself.
    const context = await runtime.getContext();
    assert.match(context, /No NeatContext Context is connected to this session/);
    assert.doesNotMatch(context, /Connect Claude Desktop/);
  });

  it("reconnects the remembered context after the app restarts", async () => {
    await runtime.commandUse("payment team");
    companion.restart();
    assert.match(await runtime.commandStatus(), /Connected context: payment team/);
    assert.match(await runtime.getContext(), /Connected context: payment team/);
  });

  it("keeps two pi sessions on different contexts", async () => {
    session.bindPiSessionId("window-one");
    await runtime.commandUse("payment team");
    session.bindPiSessionId("window-two");
    await runtime.commandUse("Dokploy");

    assert.match(await runtime.commandStatus(), /Connected context: Dokploy/);
    session.bindPiSessionId("window-one");
    assert.match(await runtime.commandStatus(), /Connected context: payment team/);
  });

  it("sends the session header the app keys connections by", async () => {
    session.bindPiSessionId("header-check");
    await runtime.commandUse("payment team");
    assert.ok(companion.state.sessionHeaders.includes("header-check"));
  });

  it("exposes the connected context's extension tools through one proxy", async () => {
    await runtime.commandUse("payment team");
    const tools = await runtime.listExtensionTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["demo_ctx_payments"]
    );
    // get_context names them, so the model knows what the proxy can reach
    // without a schema per tool sitting in the prompt all session.
    assert.match(await runtime.getContext(), /demo_ctx_payments/);
  });

  it("refuses an extension tool the connection does not publish", async () => {
    await runtime.commandUse("payment team");
    const refused = await runtime.callExtensionTool({ tool: "not_a_tool" });
    assert.match(refused, /is not an extension tool on this connection/);
    assert.match(refused, /demo_ctx_payments/);
  });

  it("says a lite context has no extension tools", async () => {
    await runtime.saveContext({
      name: "Local notes",
      profile: "# Local notes\n\n## Purpose\n\nNotes.\n",
      routingDescription: "local scratch notes",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n" }]
    });
    await runtime.commandUse("Local notes");
    assert.deepEqual(await runtime.listExtensionTools(), []);
    assert.match(await runtime.callExtensionTool({ tool: "demo_ctx_payments" }), /no extension tools/);
  });

  it("switches a session from a standard context to a lite one", async () => {
    await runtime.commandUse("payment team");
    await runtime.saveContext({
      name: "Local notes",
      profile: "# Local notes\n\n## Purpose\n\nNotes.\n",
      routingDescription: "local scratch notes",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n" }]
    });

    const switched = await runtime.useContext({ context: "Local notes", requested: true });
    assert.match(switched, /Switched this session to "Local notes"/);
    const context = await runtime.getContext();
    assert.match(context, /NeatContext Lite — connected context: Local notes/);
    // The app must not be left holding the old standard connection while a lite
    // context is selected, or the two sources disagree about what is grounded.
    assert.equal(companion.state.bySession.get("pi-standard-session") ?? null, null);
  });

  it("tells the session it is on a standard context in its instructions", async () => {
    await runtime.commandUse("payment team");
    const instructions = await runtime.sessionInstructions();
    assert.match(instructions, /grounded in a NeatContext Context/);
    assert.match(instructions, /neatcontext_tool/);
  });
});
