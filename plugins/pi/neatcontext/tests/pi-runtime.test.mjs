// The pi runtime, driven the way the extension drives it: in-process, with a
// bound session id and no MCP anywhere.
//
// These run against a temporary NEATCONTEXT_COMPANION_FILE, so nothing here
// touches a real ~/.neatcontext. Most of them run with no companion at all —
// that is the property lite contexts exist to have.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

let home;
let docs;
let runtime;
let session;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-pi-test-"));
  // Nothing ever writes this file in this suite: the desktop app is simply not
  // running, which is the case lite contexts have to survive.
  process.env.NEATCONTEXT_COMPANION_FILE = path.join(home, "companion.json");

  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");

  // Imported after the env var is set, so the very first call resolves paths
  // inside the temporary home.
  runtime = await import("../src/pi/runtime.mjs");
  session = await import("../src/pi/session.mjs");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  session.bindPiSessionId("pi-test-session");
});

const PROFILE = "# Orders\n\n## Purpose\n\nOrder pipeline.\n";

function createOrders(name = "Orders") {
  return runtime.createContext({
    name,
    knowledgeFolder: docs,
    profile: PROFILE,
    useWhen: "order-events lag, order-projection workers, partition skew"
  });
}

describe("session identity", () => {
  it("accepts the ids pi actually issues and rejects unusable ones", () => {
    assert.equal(session.normalizePiSessionId("0199f0aa-7b3e-7000-8000-abc"), "0199f0aa-7b3e-7000-8000-abc");
    assert.equal(session.normalizePiSessionId("  pi.session_1  "), "pi.session_1");
    assert.equal(session.normalizePiSessionId(""), null);
    assert.equal(session.normalizePiSessionId("../escape"), null);
    assert.equal(session.normalizePiSessionId("-leading"), null);
    assert.equal(session.normalizePiSessionId(undefined), null);
  });

  it("keeps the previous binding when pi offers an unusable id", () => {
    session.bindPiSessionId("good-session");
    assert.equal(session.bindPiSessionId("../bad"), null);
    assert.equal(session.piSessionId(), "good-session");
    assert.equal(session.isPiSessionBound(), true);
  });

  it("gives each pi session its own connected context", async () => {
    await createOrders();
    session.bindPiSessionId("session-one");
    await runtime.commandUse("Orders");
    assert.match(await runtime.commandStatus(), /Connected context: Orders \(lite\)/);

    session.bindPiSessionId("session-two");
    assert.match(await runtime.commandStatus(), /No context is connected yet/);
  });
});

describe("lite contexts, with no desktop app", () => {
  it("creates, lists, connects, and grounds", async () => {
    const created = await createOrders();
    assert.match(created, /Created the "Orders" lite context/);
    assert.match(created, /Routes here for:  order-events lag/);

    const list = await runtime.commandList();
    assert.match(list, /Lite contexts:\n {2}1\. Orders/);
    assert.match(list, /Standard contexts:\n {2}\(none/);

    assert.match(await runtime.commandUse("Orders"), /Connected the "Orders" lite context/);

    const context = await runtime.getContext();
    assert.match(context, /NeatContext Lite — connected context: Orders/);
    assert.match(context, /runbook\.md/);
    // The plugin's own notes ride on every get_context, so a mid-session mode
    // change reaches the model without a restart.
    assert.match(context, /## Connecting a context, in pi/);
  });

  it("says nothing is connected in pi's own terms", async () => {
    const context = await runtime.getContext();
    assert.match(context, /No NeatContext Context is connected to this session/);
    assert.match(context, /\/neatcontext-use/);
    // Never Claude's or Codex's command syntax.
    assert.doesNotMatch(context, /\/neatcontext:/);
    assert.doesNotMatch(context, /\$neatcontext:/);
  });

  it("refuses a knowledge folder that is not there", async () => {
    const result = await runtime.createContext({
      name: "Ghost",
      knowledgeFolder: path.join(home, "nope"),
      profile: PROFILE
    });
    assert.match(result, /No folder at/);
  });

  it("disconnects, and reports nothing left to disconnect", async () => {
    await createOrders();
    await runtime.commandUse("Orders");
    assert.match(await runtime.commandDisconnect(), /Disconnected the "Orders" context/);
    assert.match(await runtime.commandDisconnect(), /No context is connected to this session/);
  });

  it("deletes only after confirmation", async () => {
    await createOrders();
    const plan = await runtime.deleteContext("Orders");
    assert.equal(plan.done, false);
    assert.equal(plan.target.name, "Orders");
    // A folder the user brought is theirs, and delete has to say it stays.
    assert.match(plan.text, /will NOT be touched/);

    const done = await runtime.deleteContext("Orders", { confirm: true });
    assert.equal(done.done, true);
    assert.match(done.text, /Deleted the "Orders" lite context/);
    assert.match(await runtime.commandList(), /\(none — create one/);
  });
});

describe("routing", () => {
  it("reports and changes the mode for this session", async () => {
    assert.match(await runtime.commandMode(), /Context routing is ask \(the default\)/);
    assert.match(await runtime.commandMode("auto"), /now auto for this session/);
    assert.match(await runtime.commandMode(), /Context routing is auto \(this session\)/);
    assert.match(await runtime.commandMode("sideways"), /is not a mode/);
  });

  // pi cannot remove a registered tool mid-session, so manual mode is a refusal
  // rather than an absent tool. The contract the user sees is unchanged.
  it("refuses to switch in manual mode instead of hiding the tool", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");
    await runtime.commandMode("manual");

    const refused = await runtime.useContext({ context: "Billing", requested: false });
    assert.match(refused, /routing is off \(manual mode\)/);
    assert.match(refused, /\/neatcontext-use Billing/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);
  });

  it("asks before switching in ask mode, then switches when the user agreed", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");

    assert.match(await runtime.useContext({ context: "Billing" }), /ask mode, so nothing has changed/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);

    const switched = await runtime.useContext({
      context: "Billing",
      requested: true,
      alias: "invoices"
    });
    assert.match(switched, /Switched this session to "Billing"/);
    assert.match(switched, /"invoices" will route here from now on/);
    assert.match(await runtime.commandStatus(), /Connected context: Billing/);
  });

  it("remembers a declined switch for the rest of the session", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");
    await runtime.commandMode("auto");

    assert.match(
      await runtime.useContext({ context: "Billing", declined: true }),
      /will not be suggested again this session/
    );
    assert.match(
      await runtime.useContext({ context: "Billing" }),
      /already declined switching to "Billing"/
    );
  });

  it("previews a context without connecting it", async () => {
    await createOrders();
    await createOrders("Billing");
    await runtime.commandUse("Orders");

    const preview = await runtime.previewContext({ context: "Billing" });
    assert.match(preview, /# Billing \(lite\)/);
    assert.match(preview, /runbook\.md/);
    assert.match(await runtime.commandStatus(), /Connected context: Orders/);
  });

  it("records a routing description and an alias", async () => {
    await createOrders();
    const described = await runtime.describeContext({
      context: "Orders",
      useWhen: "order-projection partition lag",
      alias: "the order thing"
    });
    assert.match(described, /now routes for: order-projection partition lag/);
    assert.match(described, /"the order thing" now routes to "Orders"/);
    assert.match(await runtime.getContext(), /order-projection partition lag/);
  });

  it("puts the routing menu and connection rule into every turn's instructions", async () => {
    await createOrders();
    const instructions = await runtime.sessionInstructions();
    assert.match(instructions, /^# NeatContext/);
    assert.match(instructions, /No NeatContext Context is connected to this session right now/);
    assert.match(instructions, /## Contexts available on this machine/);
    assert.match(instructions, /- \*\*Orders\*\* \(lite\)/);
    assert.match(instructions, /## Connecting a context, in pi/);
  });

  it("drops the menu in manual mode", async () => {
    await createOrders();
    await runtime.commandMode("manual");
    const instructions = await runtime.sessionInstructions();
    assert.doesNotMatch(instructions, /## Contexts available on this machine/);
    assert.match(instructions, /## Connecting a context, in pi/);
  });
});

describe("save", () => {
  const knowledge = [{ path: "session-summary.md", content: "# Summary\n\nPartition 17 lagged.\n" }];

  it("plans a create when nothing matches the name", async () => {
    assert.match(await runtime.saveContext({ name: "Queue lag" }), /Save action: create/);
    assert.match(await runtime.saveContext({}), /Save action: create/);
  });

  it("creates from a capture passed as arguments", async () => {
    const saved = await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    assert.match(saved, /Saved context: Queue lag/);
    assert.match(saved, /\/neatcontext-use Queue lag/);
    assert.match(await runtime.commandList(), /Queue lag/);
  });

  it("plans an update with the existing profile and knowledge inline", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });

    const plan = await runtime.saveContext({ name: "Queue lag" });
    assert.match(plan, /Save action: update/);
    assert.match(plan, /targetId: lite:queue-lag/);
    assert.match(plan, /baseHash: [0-9a-f]{8}/);
    // The merge inputs come back with the plan, so drafting is one round trip.
    assert.match(plan, /## Existing domain profile/);
    assert.match(plan, /Partition skew/);
    assert.match(plan, /### session-summary\.md/);
    assert.match(plan, /Partition 17 lagged/);
  });

  it("previews an update, and only applies it on confirm", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    const plan = await runtime.saveContext({ name: "Queue lag" });
    const targetId = /targetId: (\S+)/.exec(plan)[1];
    const baseHash = /baseHash: (\S+)/.exec(plan)[1];

    const capture = {
      targetId,
      baseHash,
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew, now with a fix.\n",
      routingDescription: "order-events partition lag",
      knowledge: [
        ...knowledge,
        { path: "decisions.md", content: "# Decisions\n\nSplit the partition key.\n" }
      ]
    };

    const preview = await runtime.saveContext(capture);
    assert.match(preview, /Update the "Queue lag" lite context\?/);
    assert.match(preview, /Add: decisions\.md/);
    assert.match(preview, /`confirm: true`/);

    const applied = await runtime.saveContext({ ...capture, confirm: true });
    assert.match(applied, /Updated context: Queue lag/);
    assert.match(await runtime.saveContext({ name: "Queue lag" }), /Split the partition key/);
  });

  // Save resolves names more strictly than use_context on purpose: partial
  // matching would turn "save as" into a surprising mutation.
  it("asks which context a near-miss name meant instead of creating one", async () => {
    await createOrders("Queue lag");
    const plan = await runtime.saveContext({ name: "Queue lags" });
    assert.match(plan, /Save action: choose/);
    assert.match(plan, /Queue lag \(lite\)/);
  });

  it("updates the context this session is already on when given no name", async () => {
    await runtime.saveContext({
      name: "Queue lag",
      profile: "# Queue lag\n\n## Purpose\n\nPartition skew.\n",
      routingDescription: "order-events partition lag",
      knowledge
    });
    await runtime.commandUse("Queue lag");
    assert.match(await runtime.saveContext({}), /Save action: update/);
  });
});
