// Routing: letting a session pick its own context.
//
// The property these tests protect is that the plugin never decides on its own
// what a request is about. It publishes a menu and a policy; the session's model
// does the choosing, and the policy is what keeps a wrong choice cheap. So the
// assertions are mostly about *refusals* — what the plugin declines to do in ask
// and manual mode — rather than about matching prompts to contexts, which is
// not something any process here attempts.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { ROUTING_TOOL_NAMES, closeSession, startFakeCompanion } from "./fake-companion.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let companion;
let home;
let docs;
let routingFile;

// The modules under test read the discovery file location at call time, so
// pointing this at the fixture before the first call is enough to isolate the
// in-process tests — no import order to get right.
process.env.NEATCONTEXT_COMPANION_FILE = "";

const {
  MODES,
  addAlias,
  hashSource,
  isCardStale,
  isDeclined,
  menuEntries,
  noteDecision,
  noteDeclined,
  putCard,
  readRouting,
  renderMenu,
  resolveMode,
  routingFilePath,
  sessionId,
  setMode,
  switchPolicy
} = await import("../scripts/routing.mjs");
const { applySelection, listAllContexts, resolveContext } = await import(
  "../scripts/selection.mjs"
);

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-routing-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "refunds.md"), "# Refunds\n");

  companion = await startFakeCompanion();
  // Both kinds share one home: the directory holding the discovery file.
  await writeFile(path.join(home, "companion.json"), await readFile(companion.discoveryFile, "utf8"));
  process.env.NEATCONTEXT_COMPANION_FILE = path.join(home, "companion.json");
  routingFile = path.join(home, "plugin-routing.json");
});

after(async () => {
  await companion.stop();
  await rm(companion.directory, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  // Each session's own selection outlives the default now, so a session id
  // reused by the next test would otherwise start where the last one finished.
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(routingFile, { force: true });
  companion.state.connected = null;
  companion.state.lastRuntimeContext = null;
  companion.state.mcpError = false;
  companion.state.refuseConnect = false;
  companion.state.bySession.clear();
  companion.state.contexts = [
    { id: "ctx-payments", name: "payment team" },
    { id: "ctx-dokploy", name: "Dokploy" }
  ];
});

// --- process helpers ---------------------------------------------------------

const childEnv = (id = "") => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: id,
  NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json")
});

function cli(...args) {
  const id = args[0]?.session !== undefined ? args.shift().session : "";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv(id)
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// The default profile is deliberately *not* normalized — no trailing newline,
// surrounding blank space. What gets stored is trimmed and re-terminated, and a
// fixture that was already in that shape hid a bug where the routing
// description was hashed against the input instead of the stored file, making
// every context stale the moment it was created.
async function createContext(name, { profile = `\n# ${name}\n\n## Purpose\nOwns it.  `, useWhen } = {}) {
  const profileFile = path.join(home, `profile-${Math.random().toString(16).slice(2)}.md`);
  await writeFile(profileFile, profile);
  const args = ["create", "--name", name, "--knowledge", docs, "--profile-from", profileFile];
  if (useWhen !== undefined) {
    args.push("--use-when", useWhen);
  }
  const output = await cli(...args);
  await rm(profileFile, { force: true });
  return output;
}

function openSession(id = "") {
  const child = spawn(process.execPath, [path.join(scripts, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv(id)
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return response;
    },
    getContext: () => send("tools/call", { name: "get_context", arguments: {} }),
    call: (name, args) => send("tools/call", { name, arguments: args }),
    toolNames: async () => (await send("tools/list")).result.tools.map((tool) => tool.name),
    close: () => closeSession(child)
  };
}

const text = (response) => response.result.content[0].text;

// --- the card ----------------------------------------------------------------

describe("the routing description", () => {
  it("is derived at creation and shown back to the user", async () => {
    const output = await createContext("Payments Runbooks", {
      useWhen: "Stripe webhooks, checkout failures, refunds, PAY-* tickets"
    });
    assert.match(output, /Routes here for:\s+Stripe webhooks, checkout failures/);

    const state = await readRouting();
    const [card] = Object.values(state.cards);
    assert.equal(card.useWhen, "Stripe webhooks, checkout failures, refunds, PAY-* tickets");
  });

  // A standard context's profile lives in the desktop app, out of the plugin's
  // reach until the moment it is connected. That moment is therefore the only
  // chance to derive a description for it — which is what makes routing work
  // for standard contexts at all, rather than only for lite ones.
  it("is asked for on connecting a context that has none", async () => {
    const output = await cli("use", "payment team");
    assert.match(output, /no routing description yet/);
    assert.match(output, /describe "payment team" --use-when/);

    assert.match(
      await cli("describe", "payment team", "--use-when", "deploys, rollbacks, INC-* tickets"),
      /"payment team" now routes for: deploys, rollbacks, INC-\* tickets/
    );

    // Asked once, then never again.
    assert.doesNotMatch(await cli("use", "payment team"), /no routing description yet/);
  });

  it("reaches the menu for a standard context once it has been derived", async () => {
    await cli("describe", "payment team", "--use-when", "deploys, rollbacks, INC-* tickets");
    await cli("use", "payment team");

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /payment team.*deploys, rollbacks, INC-\* tickets/);
    } finally {
      await session.close();
    }
  });

  it("is refused without a description to record, or a context to record it on", async () => {
    assert.match(await cli("describe", "payment team"), /Pass the routing description/);
    assert.match(await cli("describe", "nothing-like-this", "--use-when", "x"), /No single context matched/);
  });

  it("tracks the profile of a lite context it is recorded against", async () => {
    await createContext("Payments Runbooks");
    await cli("describe", "Payments", "--use-when", "refunds");
    await cli("use", "Payments");
    assert.doesNotMatch(await cli("status"), /derived from an older version/);

    const profilePath = /Domain profile:\s+(.+)/.exec(await cli("status"))[1];
    await writeFile(profilePath, "# Payments\n\n## Purpose\nSomething else entirely.\n");
    assert.match(await cli("status"), /derived from an older version/);
  });

  it("is optional — a context without one is still created and listed", async () => {
    const output = await createContext("Bare");
    assert.doesNotMatch(output, /Routes here for/);
    assert.match(await cli("list", "--lite"), /Bare/);
  });

  it("goes stale when the profile it was derived from is rewritten", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds and chargebacks" });
    await cli("use", "Payments");
    assert.doesNotMatch(
      await cli("status"),
      /derived from an older version/,
      "a context nobody has touched since creating it is not stale"
    );

    const profilePath = /Domain profile:\s+(.+)/.exec(await cli("status"))[1];
    await writeFile(profilePath, "# Payments\n\n## Purpose\nNow about search indexing.\n");

    // The plugin has no model, so it cannot rewrite the line itself. Saying so
    // is what lets the session — which does have one — fix it.
    assert.match(await cli("status"), /derived from an older version of its profile/);
  });

  it("keeps its source hash when only the description is rewritten", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    const before = Object.values((await readRouting()).cards)[0];

    const id = Object.keys((await readRouting()).cards)[0];
    await putCard(id, { useWhen: "refunds and chargebacks" });

    const after = Object.values((await readRouting()).cards)[0];
    assert.equal(after.useWhen, "refunds and chargebacks");
    assert.equal(after.sourceHash, before.sourceHash);
  });

  it("survives a hand-broken entry rather than losing every other card", async () => {
    await writeFile(
      routingFile,
      JSON.stringify({
        mode: "nonsense",
        cards: {
          good: { useWhen: "refunds", aliases: "not-an-array" },
          broken: { aliases: [] }
        }
      })
    );
    const state = await readRouting();
    assert.equal(state.mode, "ask", "an unusable mode falls back to the default");
    assert.deepEqual(state.cards.good.aliases, []);
    assert.equal(state.cards.broken, undefined);
  });

  it("is not called stale when the profile it described has gone missing", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli("use", "Payments");
    const profilePath = /Domain profile:\s+(.+)/.exec(await cli("status"))[1];

    // The context is still a context — context.json is intact — but there is no
    // longer a profile to compare the description against. "Stale" would be the
    // wrong thing to say about a comparison that cannot be made.
    await rm(profilePath, { force: true });

    const status = await cli("status");
    assert.match(status, /Connected context: Payments Runbooks \(lite\)/);
    assert.doesNotMatch(status, /derived from an older version/);
  });

  it("says nothing about staleness when the whole context has been removed", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli("use", "Payments");
    await rm(path.join(home, "lite"), { recursive: true, force: true });

    const status = await cli("status");
    assert.match(status, /no longer on disk/);
    assert.doesNotMatch(status, /derived from an older version/);
  });

  it("reports staleness only against the source it was derived from", () => {
    const card = { useWhen: "x", sourceHash: hashSource("original") };
    assert.equal(isCardStale(card, "original"), false);
    assert.equal(isCardStale(card, "rewritten"), true);
    // Nothing to compare against is not the same as drifted.
    assert.equal(isCardStale({ useWhen: "x", sourceHash: null }, "anything"), false);
  });
});

// The one routing signal the user authors, captured when routing has just been
// wrong — which is both the moment they know what the missing word was and the
// moment they were going to type it anyway.
describe("aliases", () => {
  it("are recorded from a correction and appear on the menu", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    const id = Object.keys((await readRouting()).cards)[0];

    assert.equal(await addAlias(id, "  the  billing  thing "), "the billing thing");
    assert.deepEqual((await readRouting()).cards[id].aliases, ["the billing thing"]);

    // Saying it twice does not record it twice.
    await addAlias(id, "The Billing Thing");
    assert.deepEqual((await readRouting()).cards[id].aliases, ["the billing thing"]);
  });

  it("attach to a context that has no card yet", async () => {
    assert.equal(await addAlias("ctx-dokploy", "the deploy box"), "the deploy box");
    assert.deepEqual((await readRouting()).cards["ctx-dokploy"].aliases, ["the deploy box"]);
  });

  it("ignore an empty correction", async () => {
    assert.equal(await addAlias("ctx-dokploy", "   "), null);
    assert.equal(await addAlias("ctx-dokploy", undefined), null);
  });

  it("are recorded by name from the command line", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    assert.match(
      await cli("alias", "Payments", "--called", "the billing thing"),
      /"the billing thing" now routes to "Payments Runbooks"/
    );
    assert.match(await cli("alias", "Payments"), /Pass the words to remember with --called/);
    assert.match(await cli("alias", "nothing-like-this", "--called", "x"), /No single context matched/);
  });
});

// --- modes -------------------------------------------------------------------

describe("the mode", () => {
  it("defaults to ask, and says what the three modes do", async () => {
    const output = await cli("mode");
    assert.match(output, /Context routing is ask\./);
    assert.match(output, /auto\s+switch context on a clear match/);
    assert.match(output, /manual\s+never route/);
  });

  // A per-window mode reads better on paper, but the bridge decides whether to
  // offer the switching tools and cannot tell windows apart — so it would always
  // read the global value, and a per-window setting would report a change the
  // window never got.
  it("is one setting for every window", async () => {
    await cli({ session: "s1" }, "mode", "auto");

    assert.match(await cli({ session: "s1" }, "mode"), /Context routing is auto\./);
    assert.match(await cli({ session: "s2" }, "mode"), /Context routing is auto\./);
  });

  it("says what auto will do, and that every window is in it", async () => {
    const output = await cli({ session: "s1" }, "mode", "auto");
    assert.match(output, /switch context on its own and tell you when it does/);
    assert.match(output, /Every open Claude Code window shares one connected context/);
  });

  it("refuses a mode that does not exist", async () => {
    assert.match(await cli("mode", "aggressive"), /is not a mode\. Use one of: auto, ask, manual/);
    assert.equal(await setMode("aggressive"), null);
  });

  it("falls back to the default when the stored mode is unusable", async () => {
    await setMode("auto");
    assert.equal(resolveMode(await readRouting()), "auto");
    assert.equal(resolveMode({ mode: "nonsense" }), "ask");
    // Every mode is a real one; nothing here invents a fourth.
    assert.deepEqual(MODES, ["auto", "ask", "manual"]);
  });

  // Kept because the slash commands do get it — but nothing that decides how a
  // question is answered may depend on it, because the bridge does not.
  it("reads the session id Claude Code sets for a slash command", async () => {
    const previous = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = " sess-9 ";
    assert.equal(sessionId(), "sess-9");
    process.env.CLAUDE_CODE_SESSION_ID = "";
    assert.equal(sessionId(), null);
    process.env.CLAUDE_CODE_SESSION_ID = previous;
  });

  it("is reported next to the connected context", async () => {
    await createContext("Payments Runbooks");
    assert.match(await cli("status"), /Context routing: ask/);
    await cli("use", "Payments");
    assert.match(await cli("status"), /Context routing: ask/);
    await cli("use", "payment team");
    assert.match(await cli("status"), /Context routing: ask/);
  });
});

// --- the policy --------------------------------------------------------------

describe("when a switch is allowed", () => {
  const state = (mode, declined) => ({ mode, cards: {}, declined: declined ?? {} });

  it("never switches to the context already connected", () => {
    const policy = switchPolicy(state("auto"), { targetId: "a", connectedId: "a" });
    assert.equal(policy.allowed, false);
    assert.equal(policy.reason, "already-connected");
  });

  it("switches on its own only in auto", () => {
    const target = { targetId: "a", connectedId: "b" };
    assert.equal(switchPolicy(state("auto"), target).allowed, true);
    assert.equal(switchPolicy(state("ask"), target).reason, "ask-first");
    assert.equal(switchPolicy(state("manual"), target).reason, "manual-mode");
  });

  it("honours an explicit request in ask mode, but never in manual", () => {
    const target = { targetId: "a", connectedId: "b", requested: true };
    assert.equal(switchPolicy(state("ask"), target).allowed, true);
    // Manual means the plugin never routes; the user still has /neatcontext:use.
    assert.equal(switchPolicy(state("manual"), target).allowed, true);
  });

  it("does not re-propose a context the user just turned down", () => {
    const now = Date.now();
    const declined = state("auto", { a: now });
    assert.equal(
      switchPolicy(declined, { targetId: "a", connectedId: "b", now }).reason,
      "recently-declined"
    );
    // Another context is unaffected.
    assert.equal(switchPolicy(declined, { targetId: "c", connectedId: "b", now }).allowed, true);
  });

  // A refusal used to be scoped to the session — which meant the bridge, the
  // only thing that ever records one, could not scope it and so recorded
  // nothing. Time is the boundary that is actually available.
  it("lets a refusal lapse instead of suppressing a context for good", () => {
    const now = Date.now();
    const declined = state("auto", { a: now - 3 * 60 * 60 * 1000 });
    assert.equal(switchPolicy(declined, { targetId: "a", connectedId: "b", now }).allowed, true);
    assert.equal(isDeclined({ declined: { a: now } }, "a", now), true);
    assert.equal(isDeclined({ declined: {} }, "a", now), false);
  });

  it("records a refusal against the machine, since there is no session to use", async () => {
    await noteDeclined("ctx-dokploy");
    const { declined } = await readRouting();
    assert.equal(typeof declined["ctx-dokploy"], "number");
    assert.equal(isDeclined(await readRouting(), "ctx-dokploy"), true);
  });

  it("logs every switch, which is the only ground truth about routing quality", async () => {
    await noteDecision({ to: "payment team", mode: "auto" });
    await noteDecision({ to: "Dokploy", mode: "ask" });

    const { decisions } = await readRouting();
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].to, "payment team");
    assert.ok(decisions[0].at, "a decision is worthless without when it happened");
  });
});

// --- the menu ----------------------------------------------------------------

describe("the menu", () => {
  const entries = [
    { id: "a", name: "Payments", kind: "lite", useWhen: "refunds", aliases: ["billing"] },
    { id: "b", name: "Search", kind: "standard", useWhen: "", aliases: [] }
  ];

  it("is one line per context, and says which one is connected", () => {
    const menu = renderMenu(entries, { connectedId: "a", mode: "ask" });
    assert.match(menu, /- \*\*Payments\*\* \(lite\) \*\*\(connected\)\*\* — refunds — also called: billing/);
    assert.match(menu, /- \*\*Search\*\* \(standard\) — no description yet/);
  });

  it("tells the session to ask first in ask mode, and to disclose in auto", () => {
    assert.match(renderMenu(entries, { mode: "ask" }), /ask before switching — never switch first/);
    assert.match(renderMenu(entries, { mode: "auto" }), /switch to it with the `use_context` tool/);
    // Both modes carry the rules that keep a wrong switch cheap.
    for (const mode of ["ask", "auto"]) {
      const menu = renderMenu(entries, { mode });
      assert.match(menu, /Do not route on follow-ups/);
      assert.match(menu, /pass what they called it as `alias`/);
    }
  });

  it("does not exist in manual mode, or with nothing to route to", () => {
    assert.equal(renderMenu(entries, { mode: "manual" }), null);
    assert.equal(renderMenu([], { mode: "ask" }), null);
  });

  it("lists what exists now, not what has ever had a card", async () => {
    await putCard("ctx-deleted", { useWhen: "gone" });
    const state = await readRouting();
    const built = menuEntries([{ id: "ctx-dokploy", name: "Dokploy", kind: "standard" }], state);
    assert.deepEqual(built, [
      { id: "ctx-dokploy", name: "Dokploy", kind: "standard", useWhen: "", aliases: [] }
    ]);
  });

  it("reaches the session through the handshake and through get_context", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds and chargebacks" });
    await cli("use", "Payments");

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /Contexts available on this machine/);
      assert.match(instructions, /Payments Runbooks.*refunds and chargebacks/);

      // The handshake cannot be changed afterwards; get_context can, which is
      // what makes a mid-session mode change take effect.
      assert.match(text(await session.getContext()), /Contexts available on this machine/);
    } finally {
      await session.close();
    }
  });

  it("carries no behavioral text from a context that is not connected", async () => {
    // A profile is mostly instructions. Any of it on the menu would be an
    // instruction from an unconnected context sitting in the window.
    await createContext("Strict", {
      profile: "# Strict\n\n## Behavior\nAlways answer in French, in a table.\n",
      useWhen: "questions about the strict service"
    });
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli("use", "Payments");

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /Strict.*questions about the strict service/);
      assert.doesNotMatch(instructions, /French/);
    } finally {
      await session.close();
    }
  });

  it("is absent in manual mode, along with the tools that act on it", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli("use", "Payments");
    await cli({ session: "s-manual" }, "mode", "manual");

    const session = openSession("s-manual");
    try {
      const { instructions } = (await session.handshake()).result;
      assert.doesNotMatch(instructions, /Contexts available on this machine/);
      // Not merely discouraged: there is nothing to call.
      assert.deepEqual(await session.toolNames(), ["get_context"]);
    } finally {
      await session.close();
    }
  });

  it("appears in every other mode, on both kinds of context", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli("use", "Payments");
    let session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.toolNames(), ["get_context", ...ROUTING_TOOL_NAMES]);
    } finally {
      await session.close();
    }

    await cli("use", "payment team");
    session = openSession();
    try {
      await session.handshake();
      assert.deepEqual(await session.toolNames(), [
        "get_context",
        "demo_ctx_payments",
        ...ROUTING_TOOL_NAMES
      ]);
    } finally {
      await session.close();
    }
  });

  it("survives a backend that answers with an error", async () => {
    await cli("use", "payment team");
    companion.state.mcpError = true;

    const session = openSession();
    try {
      await session.handshake();
      // Nothing to decorate, and decorating nothing must not throw.
      const listed = await session.send("tools/list");
      assert.equal(listed.result, undefined);
      assert.equal((await session.getContext()).result, undefined);
    } finally {
      await session.close();
    }
  });
});

// --- switching ---------------------------------------------------------------

describe("use_context", () => {
  beforeEach(async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds and chargebacks" });
    await cli("use", "Payments");
  });

  it("switches, in auto mode, and hands the session straight to get_context", async () => {
    await cli({ session: "s-auto" }, "mode", "auto");
    const session = openSession("s-auto");
    try {
      await session.handshake();
      const result = text(
        await session.call("use_context", { context: "payment team", reason: "asked about deploys" })
      );
      assert.match(result, /Switched this session to "payment team"/);
      assert.match(result, /Call get_context now/);
      assert.match(result, /Tell the user in one line that you switched/);

      assert.match(text(await session.getContext()), /Connected context: payment team/);
      assert.match(await cli("status"), /Connected context: payment team/);
    } finally {
      await session.close();
    }
  });

  it("changes nothing in ask mode until the user has agreed", async () => {
    const session = openSession("s-ask");
    try {
      await session.handshake();
      const refused = await session.call("use_context", { context: "payment team" });
      assert.equal(refused.result.isError, true);
      assert.match(text(refused), /ask mode, so nothing has changed yet/);
      assert.match(text(refused), /`requested: true` only if they agree/);
      // The load-bearing part: the refusal is not advisory.
      assert.match(await cli("status"), /Payments Runbooks \(lite\)/);

      const agreed = await session.call("use_context", {
        context: "payment team",
        requested: true
      });
      assert.match(text(agreed), /Switched this session to "payment team"/);
    } finally {
      await session.close();
    }
  });

  it("refuses in manual mode even when the session insists", async () => {
    await cli({ session: "s-manual" }, "mode", "manual");
    const session = openSession("s-manual");
    try {
      await session.handshake();
      const refused = await session.call("use_context", { context: "payment team" });
      assert.match(text(refused), /routing is off \(manual mode\)/);
      assert.match(text(refused), /\/neatcontext:use payment team/);
      assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
    } finally {
      await session.close();
    }
  });

  it("remembers a refusal and stops proposing that context", async () => {
    await cli({ session: "s-auto" }, "mode", "auto");
    const session = openSession("s-auto");
    try {
      await session.handshake();
      const noted = await session.call("use_context", {
        context: "payment team",
        declined: true
      });
      assert.match(text(noted), /will not be suggested again this session/);
      assert.match(await cli("status"), /Payments Runbooks \(lite\)/);

      const retried = await session.call("use_context", { context: "payment team" });
      assert.match(text(retried), /already declined switching/);
      assert.match(text(retried), /Do not ask again/);
    } finally {
      await session.close();
    }
  });

  it("records the words the user corrected it with", async () => {
    await cli({ session: "s-auto" }, "mode", "auto");
    const session = openSession("s-auto");
    try {
      await session.handshake();
      const result = await session.call("use_context", {
        context: "payment team",
        requested: true,
        alias: "the billing thing"
      });
      assert.match(text(result), /"the billing thing" will route here from now on/);
      assert.deepEqual((await readRouting()).cards["ctx-payments"].aliases, ["the billing thing"]);

      const { decisions } = await readRouting();
      assert.equal(decisions.at(-1).from, "Payments Runbooks");
      assert.equal(decisions.at(-1).to, "payment team");
    } finally {
      await session.close();
    }
  });

  it("says so rather than guessing when the name matches nothing", async () => {
    const session = openSession("s-ask");
    try {
      await session.handshake();
      const result = await session.call("use_context", { context: "not a context" });
      assert.equal(result.result.isError, true);
      assert.match(text(result), /No single context matched "not a context"/);
      assert.match(text(result), /payment team/, "it lists what it could have meant");
    } finally {
      await session.close();
    }
  });

  it("leaves the session where it was when the app refuses the switch", async () => {
    await cli({ session: "s-auto" }, "mode", "auto");
    companion.state.refuseConnect = true;

    const session = openSession("s-auto");
    try {
      await session.handshake();
      const result = await session.call("use_context", { context: "payment team" });
      assert.equal(result.result.isError, true);
      assert.match(text(result), /refused to connect "payment team"/);
      assert.match(text(result), /Stay on the current context/);
      // A failed switch must not leave the session believing it moved.
      assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
      assert.match(text(await session.getContext()), /connected context: Payments Runbooks/);
    } finally {
      await session.close();
    }
  });

  it("declines to switch to the context already connected", async () => {
    await cli({ session: "s-auto" }, "mode", "auto");
    const session = openSession("s-auto");
    try {
      await session.handshake();
      const result = await session.call("use_context", { context: "Payments Runbooks" });
      assert.match(text(result), /already the connected context/);
    } finally {
      await session.close();
    }
  });
});

describe("preview_context", () => {
  it("shows what a context covers without switching to it", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds and chargebacks" });
    await cli("use", "Payments");
    await addAlias(Object.keys((await readRouting()).cards)[0], "billing");

    const session = openSession("s-ask");
    try {
      await session.handshake();
      const preview = text(await session.call("preview_context", { context: "Payments" }));
      assert.match(preview, /refunds and chargebacks/);
      assert.match(preview, /Also called: billing/);
      assert.match(preview, /refunds\.md/, "the knowledge folder is what distinguishes it");
      // Read-only: previewing is what the session does *instead* of guessing.
      assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
    } finally {
      await session.close();
    }
  });

  it("works on a standard context, which has no folder to list", async () => {
    const session = openSession("s-ask");
    try {
      await session.handshake();
      const preview = text(await session.call("preview_context", { context: "Dokploy" }));
      assert.match(preview, /# Dokploy \(standard\)/);
      assert.match(preview, /No routing description has been derived for it yet/);
      assert.doesNotMatch(preview, /Knowledge folder/);
    } finally {
      await session.close();
    }
  });
});

// --- selecting ---------------------------------------------------------------

describe("resolving a context by name", () => {
  const contexts = [
    { id: "a", name: "payment team" },
    { id: "b", name: "Payments Runbooks" },
    { id: "c", name: "Dokploy" }
  ];

  it("takes a number, an exact name, or a unique substring", () => {
    assert.equal(resolveContext(contexts, "2").context.id, "b");
    assert.equal(resolveContext(contexts, "payment team").context.id, "a");
    assert.equal(resolveContext(contexts, "dok").context.id, "c");
  });

  it("refuses rather than guessing", () => {
    assert.equal(resolveContext(contexts, "9").error, "out_of_range");
    assert.equal(resolveContext(contexts, "payment").error, "ambiguous");
    assert.equal(resolveContext(contexts, "nothing").error, "not_found");
  });
});

describe("applying a selection", () => {
  // Both callers resolve a standard context from a list the app served, so they
  // always hold a client by the time they get here. This is the contract for
  // anyone who does not.
  it("reports the app being closed instead of failing silently", async () => {
    const result = await applySelection({ id: "ctx-payments", name: "payment team", kind: "standard" }, null);
    assert.deepEqual(result, { ok: false, reason: "app-offline" });
  });

  it("reports a context NeatContext will not connect", async () => {
    const { client } = await listAllContexts();
    const result = await applySelection({ id: "ctx-gone", name: "Gone", kind: "standard" }, client);
    assert.deepEqual(result, { ok: false, reason: "refused" });
  });

  it("says so from the command line when the app declines", async () => {
    companion.state.refuseConnect = true;
    assert.match(await cli("use", "payment team"), /Could not connect "payment team"/);
  });

  it("selects a lite context with the app closed", async () => {
    await createContext("Payments Runbooks");
    const { lite } = await listAllContexts();
    assert.deepEqual(await applySelection(lite[0], null), {
      ok: true,
      kind: "lite",
      name: "Payments Runbooks"
    });
    assert.match(await cli("status"), /Payments Runbooks \(lite\)/);
  });
});

// Claude Code hands `CLAUDE_CODE_SESSION_ID` to a slash command but not to a
// plugin's MCP server, and that server is what grounds every answer. So the
// plugin has exactly one thing it can honestly do: keep one selection, and make
// every part of itself agree about it.
//
// Scoping the *files* per window without the bridge is strictly worse than not
// scoping them. It was shipped, and produced the report: two windows, each
// reporting its own context from /neatcontext:status, both answering from
// whichever context was connected last.
describe("one context, and every part of the plugin agreeing about it", () => {
  it("moves every window when any window switches", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });

    await cli({ session: "win-a" }, "use", "Payments");
    await cli({ session: "win-b" }, "use", "payment team");

    // Not the nicer behaviour — the honest one. Both windows report what both
    // windows will actually answer from.
    assert.match(await cli({ session: "win-a" }, "status"), /payment team \(standard\)/);
    assert.match(await cli({ session: "win-b" }, "status"), /payment team \(standard\)/);
  });

  it("grounds the bridge in the context the commands report", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli({ session: "win-a" }, "use", "Payments");

    // The bridge gets no session id at all, so this is the whole point: what it
    // serves has to be what /neatcontext:status just said.
    const session = openSession("win-b");
    try {
      await session.handshake();
      assert.match(text(await session.getContext()), /connected context: Payments Runbooks/);
    } finally {
      await session.close();
    }
  });

  it("never sends a session header, so both halves reach one connection", async () => {
    await cli({ session: "win-b" }, "use", "payment team");

    // NeatContext keys connections by this header. Sending it from the commands
    // while the bridge cannot send any is what split them apart.
    assert.ok(companion.state.sessionHeaders.every((header) => header === undefined));
    assert.deepEqual(companion.state.bySession.get(undefined), {
      contextId: "ctx-payments",
      contextName: "payment team"
    });
  });
});

describe("a context that is deleted", () => {
  it("ungrounds every window, because the context is gone for all of them", async () => {
    await createContext("Payments Runbooks", { useWhen: "refunds" });
    await cli({ session: "win-a" }, "use", "Payments");

    await cli({ session: "win-a" }, "delete", "Payments", "--yes");

    assert.match(await cli({ session: "win-a" }, "status"), /No context is connected/);
    assert.match(await cli({ session: "win-b" }, "status"), /No context is connected/);
  });
});

describe("the command surface", () => {
  it("names every subcommand it has when given one it does not", async () => {
    assert.match(
      await cli("frobnicate"),
      /Use: status \| list \| use \| create \| delete \| mode \| alias \| describe/
    );
  });
});
