// NeatContext plugin MCP server: a generic MCP-stdio <-> HTTP bridge.
//
// Claude Code launches this as an MCP server. It relays the host's MCP JSON-RPC
// to the NeatContext desktop app's local companion endpoint (POST /v1/mcp),
// which hosts the real NeatContext MCP surface (get_context and the connected
// context's extension tools). This file contains NO
// NeatContext code and never touches its binary — it only speaks MCP and the
// documented companion HTTP contract.
//
// Behaviors layered on top of a plain relay:
//   * initialize advertises tools.listChanged, and we poll the connected-context
//     version so the host refreshes its tool list when you run /neatcontext:use.
//   * NeatContext keeps its connected context in memory only, so restarting the
//     app drops it. Before anything that depends on the context, and on every
//     poll, we put the remembered selection back — otherwise a session that ran
//     /neatcontext:use keeps the old tool list but gets "no context is
//     connected" from get_context.
//   * while nothing is connected, the tool list is trimmed to get_context: the
//     app's runtime file outlives its connection, so it can still advertise the
//     previous context's extension tools.
//   * if the backend child was respawned (or NeatContext just started), a
//     "not initialized" error triggers a transparent re-handshake + retry.
//   * if NeatContext is not reachable, we answer locally so the MCP server still
//     loads; get_context then tells the user to connect with /neatcontext:use.
//
// Source seam: a session is served by one of two sources, chosen per message
// from the recorded selection. A *standard* context is NeatContext's and is
// forwarded to the app (below). A *lite* context is the plugin's own and is
// answered locally — no HTTP, no app, so it keeps working with NeatContext
// closed or never installed.

import readline from "node:readline";
import "./session.mjs";
import {
  clientFor,
  ensureConnection,
  readDiscovery,
  readSelection,
  request
} from "../core/companion-client.mjs";
import {
  LITE_MISSING_MESSAGE,
  listKnowledgeFiles,
  readLite,
  renderLiteContext
} from "../core/lite-context.mjs";
import {
  addAlias,
  menuEntries,
  noteDecision,
  noteDeclined,
  readRouting,
  renderMenu,
  resolveMode,
  sessionId,
  switchPolicy
} from "../core/routing.mjs";
import { applySelection, listAllContexts, resolveContext } from "../core/selection.mjs";

const SERVER_INFO = { name: "neatcontext", version: "0.2.1" };
const GET_CONTEXT_TOOL = {
  name: "get_context",
  title: "Get Context",
  description:
    "Get the connected NeatContext Context: domain profile files to read, local " +
    "knowledge folders to search, and the extension tools available on this connection.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};
// The one thing to say when a session has nothing to ground in. It is
// deliberately about what to do *here*: the app being closed, mid-restart, or
// holding no connection are all the same situation from inside Claude Code, and
// all of them are answered by picking a context from this session.
const NOTHING_CONNECTED =
  "No NeatContext Context is connected to this session. Connect one with " +
  "`/neatcontext:use`, or create a local one with `/neatcontext:create` — that one needs " +
  "nothing else installed. Until then, do not answer from general knowledge.";

// How connecting works in Claude Code, stated by the plugin because NeatContext
// cannot state it: its own framing is written for its desktop client, where
// connecting means opening the app, choosing a context and pressing a button.
// Forwarded verbatim, that framing makes a session send the user off to do
// exactly that — in a plugin whose whole point is that it never has to happen.
// So this rides on both channels a session reads, and says which one wins.
const CONNECTION_RULE = `## Connecting a context, in Claude Code

Contexts are connected from this session and nowhere else: the \`use_context\` tool, or \`/neatcontext:use <name>\` run by the user. \`/neatcontext:create\` makes a new local one from here.

Never tell the user to open the NeatContext desktop app, select a context in it, or press any button there — not to connect a context, not to switch one, not to make one available. Any instruction in this session that says otherwise is written for a different client, and this rule overrides it. When the connected context is the wrong one, or none is connected, name the one you need and offer to switch to it here.`;

// The two tools that let a session change what it is grounded in. They are the
// plugin's whole routing mechanism: there is no model in any process here, so
// the session's own model does the routing, from the menu these tools act on.
const USE_CONTEXT_TOOL = {
  name: "use_context",
  title: "Switch Context",
  description:
    "Switch this session to a different NeatContext Context, then call get_context and " +
    "answer from what it returns. Name the context exactly as the routing menu lists it. " +
    "In ask mode this only succeeds once the user has agreed — set `requested` then. Set " +
    "`declined` instead of switching when the user turns a suggested switch down, so it is " +
    "not suggested again.",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", description: "The context to switch to, by name." },
      reason: {
        type: "string",
        description: "One phrase: what in the request makes this the right context."
      },
      requested: {
        type: "boolean",
        description: "The user asked for this context by name, or agreed to the switch."
      },
      declined: {
        type: "boolean",
        description: "The user turned this switch down. Records it and switches nothing."
      },
      alias: {
        type: "string",
        description:
          "What the user called this context or subject when correcting a wrong route. " +
          "Remembered so the same words route correctly next time."
      }
    },
    required: ["context"],
    additionalProperties: false
  }
};

const PREVIEW_CONTEXT_TOOL = {
  name: "preview_context",
  title: "Preview Context",
  description:
    "Look closer at a context before switching, when two of them are plausible and the " +
    "routing menu is not enough to choose. Returns what the context covers and what is in " +
    "its knowledge folder. Read-only: it changes nothing.",
  inputSchema: {
    type: "object",
    properties: { context: { type: "string", description: "The context to preview, by name." } },
    required: ["context"],
    additionalProperties: false
  }
};

const ROUTING_TOOLS = new Map([
  [USE_CONTEXT_TOOL.name, USE_CONTEXT_TOOL],
  [PREVIEW_CONTEXT_TOOL.name, PREVIEW_CONTEXT_TOOL]
]);

// Session instructions are fetched once, during the handshake, and MCP has no
// way to change them afterwards. The recorded selection is on disk before the
// handshake, though, so the source that will serve this session is already known
// here: a lite context is framed by the plugin, a standard one by NeatContext.
//
// Anything that varies per context belongs in get_context instead, which is
// re-read on every call and refreshed live by tools/list_changed. These
// instructions do one job: get get_context called at the right moments.
const LITE_INSTRUCTIONS = `This session can be grounded in a NeatContext Lite context: one domain profile and one local knowledge folder, stored on this machine.

Call the get_context tool before answering anything that depends on the user's own domain, documents, tools, or team conventions — it returns the profile file to read and the knowledge folder to search. Read the profile in full: it states what the context is for, what to do, what to avoid, and how to behave, and it is your primary behavioral guide for this session.

A lite context is whatever its profile says it is. Do not assume a subject area for it, and do not impose a response format it does not ask for.

Cite the exact file path of anything you rely on. When the profile and the knowledge folder do not cover the question, say so instead of answering from general knowledge.`;

// Written to survive being wrong. These instructions are fixed at the handshake
// and MCP cannot revise them, but what they describe changes freely: NeatContext
// may not have finished starting when the host spawned this process, and a
// Context can be connected afterwards — from this session or another window.
//
// So this must never state "nothing is connected" as a settled fact. A session
// told that carries it for its whole life and answers it back to the user
// without ever calling get_context, which by then would have returned a
// perfectly good Context. Describing the handshake and deferring the current
// state to the tool is the only thing that stays true.
const NO_CONTEXT_INSTRUCTIONS = `No NeatContext Context was connected at the moment this session started. That says nothing about now: NeatContext may still have been starting up, and a Context can be connected at any time, from this session or another window.

These instructions are fixed at the handshake and cannot be updated, so they are not evidence about the current state — and you must not tell the user nothing is connected on the strength of this text.

When the user asks anything that depends on their own domain, documents, tools, or team conventions, call the get_context tool and let its answer decide:

- If it returns a Context, ground your answer in it and cite what you used.
- Only if it reports that nothing is connected, say so, and tell them to connect one with /neatcontext:use — or to create a local one with /neatcontext:create, which needs no other software.`;

// Methods whose answer depends on which context is connected.
const CONTEXT_METHODS = new Set(["tools/list", "tools/call", "prompts/list", "prompts/get"]);

// Prompts NeatContext serves that this plugin does not surface. A context here
// is whatever the user made it — plenty of them, lite ones especially, have
// nothing to do with incidents — so an incident-shaped slash command sitting in
// the menu misrepresents what the connected context is for.
const HIDDEN_PROMPTS = new Set(["analyze_incident"]);

function isHiddenPromptGet(message) {
  return message.method === "prompts/get" && HIDDEN_PROMPTS.has(message.params?.name);
}

function withoutHiddenPrompts(response) {
  if (!Array.isArray(response?.result?.prompts)) {
    return response;
  }
  return {
    ...response,
    result: {
      ...response.result,
      prompts: response.result.prompts.filter((prompt) => !HIDDEN_PROMPTS.has(prompt.name))
    }
  };
}

function writeLine(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function isNotInitializedError(response) {
  return response && response.error && response.error.code === -32002;
}

// --- NeatContext source: forwards MCP to the companion endpoint --------------

function neatContextSource() {
  async function postMcp(message, timeoutMs = 20000) {
    const discovery = await readDiscovery();
    if (!discovery) {
      throw new Error("companion offline");
    }
    const response = await request(discovery, "POST", "/v1/mcp", { body: message, timeoutMs });
    if (response.status === 202) {
      return null; // notification accepted, no body
    }
    if (response.status >= 500) {
      throw new Error(`companion error ${response.status}`);
    }
    return response.json;
  }

  return {
    // Current connection state, with the remembered context put back first if
    // NeatContext has forgotten it. Null when the app is unreachable, so an
    // offline app never looks like a disconnected context.
    async ensure() {
      const discovery = await readDiscovery();
      if (!discovery) {
        return null;
      }
      try {
        return await ensureConnection(clientFor(discovery));
      } catch {
        return null;
      }
    },
    postMcp
  };
}

// --- Lite source: answers locally, from disk ---------------------------------

// The selected lite context, or null when this session is on a standard one.
// A selection whose context was deleted out-of-band resolves to `missing` so
// get_context can say what happened instead of silently falling back to
// NeatContext and reporting "no context is connected".
async function activeLite() {
  const selection = await readSelection().catch(() => null);
  if (!selection || selection.kind !== "lite") {
    return null;
  }
  const record = await readLite(selection.contextId).catch(() => null);
  return record ? { record } : { missing: true, name: selection.contextName };
}

async function liteResponse(message, lite) {
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    return null; // notification: nothing to answer
  }
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      serverInfo: SERVER_INFO,
      // NeatContext's own framing is never borrowed for a lite context, whether
      // or not the app happens to be running.
      instructions: LITE_INSTRUCTIONS
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  // A lite context is one profile and one folder: get_context is the whole
  // surface, and there are no extensions or prompts by design.
  if (method === "tools/list") return jsonRpcResult(id, { tools: [GET_CONTEXT_TOOL] });
  if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
  if (method === "tools/call" && params?.name === GET_CONTEXT_TOOL.name) {
    const text = lite.missing ? LITE_MISSING_MESSAGE : await renderLiteContext(lite.record);
    return jsonRpcResult(id, { content: [{ type: "text", text }], isError: false });
  }
  if (method === "tools/call" || method === "prompts/get") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message:
          `"${params?.name}" is not available on a lite context. Lite contexts serve only ` +
          "get_context; extension tools come from a standard context, which this session can " +
          "connect with /neatcontext:use."
      }
    };
  }
  return jsonRpcResult(id, {});
}

// --- Offline fallback: keep the MCP server usable without NeatContext --------

function notConnected(id) {
  return jsonRpcResult(id, { content: [{ type: "text", text: NOTHING_CONNECTED }], isError: false });
}

function offlineResponse(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      serverInfo: SERVER_INFO,
      // Nothing is connected and NeatContext cannot be asked, so the session is
      // told how to get grounded rather than left with no framing at all.
      instructions: NO_CONTEXT_INSTRUCTIONS
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, { tools: [GET_CONTEXT_TOOL] });
  if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
  if (method === "tools/call" && params?.name === "get_context") {
    return notConnected(id);
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: NOTHING_CONNECTED } };
}

// --- Routing: the session picks its own context ------------------------------

// What the model needs to route: every context that exists, one line each on
// what it is for, and the rules for acting on that. Rebuilt on demand rather
// than cached, so `/neatcontext:mode` and a context created mid-session both
// take effect on the next call instead of on the next restart.
async function routingMenu() {
  const [{ contexts }, state] = await Promise.all([listAllContexts(), readRouting()]);
  const selection = await readSelection().catch(() => null);
  return renderMenu(menuEntries(contexts, state), {
    connectedId: selection?.contextId ?? null,
    mode: resolveMode(state, sessionId())
  });
}

function toolText(id, text, isError = false) {
  return jsonRpcResult(id, { content: [{ type: "text", text }], isError });
}

async function previewContext(id, target) {
  const state = await readRouting();
  const card = state.cards[target.id];
  const useWhen = card?.useWhen || target.routingDescription;
  const lines = [`# ${target.name} (${target.kind})`, ""];
  lines.push(useWhen || "No routing description has been derived for it yet.");
  if (card?.aliases?.length > 0) {
    lines.push("", `Also called: ${card.aliases.join(", ")}`);
  }
  if (target.kind === "lite") {
    const { files } = await listKnowledgeFiles(target.knowledgeFolder, { limit: 40 });
    lines.push("", "Knowledge folder holds:", "");
    lines.push(files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- (nothing yet)");
  }
  // Deliberately no profile prose. A profile is mostly behavioral, and text
  // telling the model how to answer would be acting on this context while the
  // session is still grounded in another one.
  lines.push("", `Switch to it with use_context, or stay where you are.`);
  return toolText(id, lines.join("\n"));
}

async function routingToolCall(message) {
  const { id, params } = message;
  const query = typeof params?.arguments?.context === "string" ? params.arguments.context : "";
  const { contexts, client } = await listAllContexts();
  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    return toolText(
      id,
      `No single context matched "${query}". The contexts are: ` +
        `${contexts.map((context) => context.name).join(", ") || "(none)"}.`,
      true
    );
  }
  const target = resolution.context;
  if (params.name === PREVIEW_CONTEXT_TOOL.name) {
    return previewContext(id, target);
  }

  const args = params.arguments ?? {};
  if (args.declined === true) {
    await noteDeclined(target.id);
    return toolText(
      id,
      `Noted — "${target.name}" will not be suggested again this session. Answer with the ` +
        "context that is already connected."
    );
  }

  const selection = await readSelection().catch(() => null);
  const state = await readRouting();
  const policy = switchPolicy(state, {
    id: sessionId(),
    targetId: target.id,
    connectedId: selection?.contextId ?? null,
    requested: args.requested === true
  });

  if (!policy.allowed) {
    return toolText(id, refusal(policy, target), true);
  }

  const result = await applySelection(target, client);
  if (!result.ok) {
    // Not "the app is closed": the target was resolved from a list the app
    // served moments ago, so the only failure left is the app declining.
    return toolText(
      id,
      `NeatContext refused to connect "${target.name}". Stay on the current context and tell ` +
        "the user the switch did not happen.",
      true
    );
  }

  // The alias is the only routing signal the user authors, and it arrives here
  // because a wrong route is the moment they say what it should have been.
  const alias = typeof args.alias === "string" ? await addAlias(target.id, args.alias) : null;
  await noteDecision({
    sessionId: sessionId(),
    from: selection?.contextName ?? null,
    to: target.name,
    mode: policy.mode,
    reason: typeof args.reason === "string" ? args.reason : null,
    requested: args.requested === true
  });

  return toolText(
    id,
    `Switched this session to "${result.name}".` +
      (alias ? ` "${alias}" will route here from now on.` : "") +
      " Call get_context now and answer from what it returns. Tell the user in one line that " +
      "you switched, and to what."
  );
}

function refusal(policy, target) {
  if (policy.reason === "already-connected") {
    return `"${target.name}" is already the connected context. Nothing to switch.`;
  }
  if (policy.reason === "manual-mode") {
    return (
      "Context routing is off (manual mode). Do not switch. If the answer needs a different " +
      `context, tell the user to run \`/neatcontext:use ${target.name}\`.`
    );
  }
  if (policy.reason === "declined-this-session") {
    return (
      `The user already declined switching to "${target.name}" in this session. Do not ask ` +
      "again — answer with the context that is connected, or say what it cannot cover."
    );
  }
  return (
    `Context routing is in ask mode, so nothing has changed yet. Ask the user whether to ` +
    `switch to "${target.name}", say briefly why it looks like the right one, and call this ` +
    "tool again with `requested: true` only if they agree."
  );
}

// --- Bridge loop -------------------------------------------------------------

const source = neatContextSource();
let lastInitialize = null;
let started = false;
let lastVersion = undefined;

function patchInitialize(response) {
  if (response?.result?.capabilities) {
    const tools = response.result.capabilities.tools ?? {};
    response.result.capabilities.tools = { ...tools, listChanged: true };
  }
  return response;
}

// With nothing connected, NeatContext can still list the extension tools of the
// context it served last: its runtime file outlives the connection. Advertising
// them would tell the session it is grounded when get_context says it is not.
function withConnectedTools(response, state) {
  if (!state || state.connected || !Array.isArray(response?.result?.tools)) {
    return response;
  }
  return {
    ...response,
    result: {
      ...response.result,
      tools: response.result.tools.filter((tool) => tool.name === GET_CONTEXT_TOOL.name)
    }
  };
}

async function forward(message) {
  try {
    let response = await source.postMcp(message);
    if (isNotInitializedError(response) && message.method !== "initialize" && lastInitialize) {
      // Backend was respawned or NeatContext just started: replay the handshake.
      await source.postMcp(lastInitialize);
      await source.postMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      response = await source.postMcp(message);
    }
    return response;
  } catch {
    return offlineResponse(message);
  }
}

// What the host's tool list depends on. Switching between contexts — of either
// kind — has to change this, so the extension tools of a standard context
// appear and disappear live.
async function currentVersion() {
  // The mode is part of it: leaving manual has to make the routing tools appear
  // without waiting for a restart, and entering it has to take them away.
  const mode = resolveMode(await readRouting(), sessionId());
  const lite = await activeLite();
  if (lite) {
    return `${mode}/${lite.missing ? "lite:missing" : `lite:${lite.record.id}`}`;
  }
  const version = (await source.ensure())?.version ?? null;
  return version === null ? null : `${mode}/${version}`;
}

async function handleMessage(message) {
  const isNotification = message.id === undefined || message.id === null;
  if (message.method === "initialize") {
    lastInitialize = message;
  }

  // Routing tools belong to the plugin, not to either source: they decide which
  // source serves the session next, so they are answered before that choice is
  // made and are never forwarded to NeatContext.
  if (message.method === "tools/call" && ROUTING_TOOLS.has(message.params?.name)) {
    writeLine(await routingToolCall(message));
    return;
  }

  const lite = await activeLite();

  // Re-attach the selected context before anything that reads it, so a
  // NeatContext restart mid-session cannot silently strip the grounding. A lite
  // context has nothing to re-attach: the selection file is the connection.
  //
  // The handshake counts: restarting the host with a standard context already
  // remembered must reconnect it there, so the session is grounded from its
  // first message and the first tools/list carries the extension tools —
  // by construction, not by which message the host happens to send first.
  let state;
  if (!lite && (CONTEXT_METHODS.has(message.method) || message.method === "initialize")) {
    state = await source.ensure();
    if (state && state.version !== null) {
      lastVersion = state.version;
    }
  }

  // A hidden prompt is answered here rather than forwarded, so it behaves like
  // the prompt it is not listed as: unknown.
  const response = isHiddenPromptGet(message)
    ? {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32602, message: `Unknown prompt: ${message.params?.name}` }
      }
    : lite
      ? await liteResponse(message, lite)
      : await forward(message);

  if (message.method === "initialize" && response && response.result) {
    patchInitialize(response);
    started = true;
    lastVersion = await currentVersion();
    startVersionWatch();
  }

  if (!isNotification && response) {
    writeLine(await shapeResponse(message, response, lite, state));
  }
}

// What the plugin adds to whichever source answered: how connecting works here,
// and the routing menu when there is one. Both ride on both channels on purpose.
// In the handshake, so the session knows what else exists without having to call
// anything; in every get_context result, because that one is re-read on every
// call and the handshake cannot be. Change the mode mid-session and the second
// channel is what makes it take effect.
//
// The connection rule goes last, so it is the closest thing to the answer the
// session is about to write — and it is the one part that is never omitted.
async function pluginNotes() {
  const menu = await routingMenu();
  return menu ? `${menu}\n\n${CONNECTION_RULE}` : CONNECTION_RULE;
}

async function withNotes(response, place) {
  const notes = await pluginNotes();
  if (place === "instructions") {
    const existing = response.result.instructions;
    return {
      ...response,
      result: {
        ...response.result,
        instructions: typeof existing === "string" ? `${existing}\n\n${notes}` : notes
      }
    };
  }
  const content = response.result?.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") {
    return response;
  }
  return {
    ...response,
    result: {
      ...response.result,
      content: [{ ...content[0], text: `${content[0].text}\n\n${notes}` }, ...content.slice(1)]
    }
  };
}

async function shapeResponse(message, response, lite, state) {
  if (message.method === "prompts/list") {
    return withoutHiddenPrompts(response);
  }
  if (message.method === "initialize" && response.result) {
    return withNotes(response, "instructions");
  }
  if (message.method === "tools/list") {
    const connected = lite ? response : withConnectedTools(response, state);
    return await withRoutingTools(connected);
  }
  if (message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name) {
    // With nothing connected, NeatContext answers in terms of its own client:
    // open the app, pick a context there. True of that client, wrong here — and
    // the bridge already knows the connection state, so it says it itself rather
    // than forwarding advice the user cannot act on from Claude Code.
    const grounded = lite || state?.connected;
    return withNotes(grounded ? response : notConnected(message.id), "content");
  }
  return response;
}

// Advertised in every mode but manual, where the absence of the tools is what
// "never route" means — the session cannot switch by mistake because there is
// nothing to call.
async function withRoutingTools(response) {
  if (!Array.isArray(response?.result?.tools)) {
    return response;
  }
  const state = await readRouting();
  if (resolveMode(state, sessionId()) === "manual") {
    return response;
  }
  return {
    ...response,
    result: { ...response.result, tools: [...response.result.tools, ...ROUTING_TOOLS.values()] }
  };
}

let watching = false;
function startVersionWatch() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (!started) return;
    const version = await currentVersion();
    if (version !== null && version !== lastVersion) {
      lastVersion = version;
      writeLine({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }, 1500).unref?.();
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    // Serialize so the initialize handshake and ordering are preserved.
    queue = queue.then(() => handleMessage(message)).catch(() => {});
  });
  rl.on("close", () => process.exit(0));
}

main();
