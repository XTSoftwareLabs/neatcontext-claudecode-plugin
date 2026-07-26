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
import { clientFor, ensureConnection, readDiscovery, readSelection, request } from "./companion-client.mjs";
import {
  LITE_MISSING_MESSAGE,
  listKnowledgeFiles,
  readLite,
  renderLiteContext
} from "./lite-context.mjs";
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
} from "./routing.mjs";
import { applySelection, listAllContexts, resolveContext } from "./selection.mjs";

const SERVER_INFO = { name: "neatcontext", version: "0.1.0" };
const GET_CONTEXT_TOOL = {
  name: "get_context",
  title: "Get Context",
  description:
    "Get the connected NeatContext Context: domain profile files to read, local " +
    "knowledge folders to search, and the extension tools available on this connection.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};
const OFFLINE_GET_CONTEXT =
  "NeatContext desktop is not reachable right now. Once it is running, use " +
  "/neatcontext:use to connect a Context, then ask again.";

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

const NO_CONTEXT_INSTRUCTIONS = `No NeatContext Context is connected to this session yet, so there is nothing to ground answers in.

When the user asks something that depends on their own domain, documents, tools, or team conventions, tell them to connect a Context with /neatcontext:use — or to create a local one with /neatcontext:create, which needs no other software. Then call get_context and answer from what it returns.`;

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
          "get_context; extension tools come from a standard context in the NeatContext " +
          "desktop app."
      }
    };
  }
  return jsonRpcResult(id, {});
}

// --- Offline fallback: keep the MCP server usable without NeatContext --------

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
    return jsonRpcResult(id, { content: [{ type: "text", text: OFFLINE_GET_CONTEXT }], isError: false });
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: OFFLINE_GET_CONTEXT } };
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
  const lines = [`# ${target.name} (${target.kind})`, ""];
  lines.push(card?.useWhen ? card.useWhen : "No routing description has been derived for it yet.");
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

// The routing menu rides on both channels on purpose. In the handshake, so the
// session knows what else exists without having to call anything; in every
// get_context result, because that one is re-read on every call and the
// handshake cannot be. Change the mode mid-session and the second channel is
// what makes it take effect.
async function withMenu(response, place) {
  const menu = await routingMenu();
  if (!menu) {
    return response;
  }
  if (place === "instructions") {
    const existing = response.result.instructions;
    return {
      ...response,
      result: {
        ...response.result,
        instructions: typeof existing === "string" ? `${existing}\n\n${menu}` : menu
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
      content: [{ ...content[0], text: `${content[0].text}\n\n${menu}` }, ...content.slice(1)]
    }
  };
}

async function shapeResponse(message, response, lite, state) {
  if (message.method === "prompts/list") {
    return withoutHiddenPrompts(response);
  }
  if (message.method === "initialize" && response.result) {
    return withMenu(response, "instructions");
  }
  if (message.method === "tools/list") {
    const connected = lite ? response : withConnectedTools(response, state);
    return await withRoutingTools(connected);
  }
  if (message.method === "tools/call" && message.params?.name === GET_CONTEXT_TOOL.name) {
    return withMenu(response, "content");
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
