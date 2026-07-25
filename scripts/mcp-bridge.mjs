// NeatContext plugin MCP server: a generic MCP-stdio <-> HTTP bridge.
//
// Claude Code launches this as an MCP server. It relays the host's MCP JSON-RPC
// to the NeatContext desktop app's local companion endpoint (POST /v1/mcp),
// which hosts the real NeatContext MCP surface (get_context, analyze_incident,
// and the connected context's extension tools). This file contains NO
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
// Source seam: today the only context source is NeatContext (below). A future
// local "light context" source can be added without NeatContext by routing
// handle()/version() to a local implementation.

import readline from "node:readline";
import { clientFor, ensureConnection, readDiscovery, request } from "./companion-client.mjs";

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

// Methods whose answer depends on which context is connected.
const CONTEXT_METHODS = new Set(["tools/list", "tools/call", "prompts/list", "prompts/get"]);

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

// --- Offline fallback: keep the MCP server usable without NeatContext --------

function offlineResponse(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      serverInfo: SERVER_INFO
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

async function handleMessage(message) {
  const isNotification = message.id === undefined || message.id === null;
  if (message.method === "initialize") {
    lastInitialize = message;
  }

  // Re-attach the selected context before anything that reads it, so a
  // NeatContext restart mid-session cannot silently strip the grounding.
  let state;
  if (CONTEXT_METHODS.has(message.method)) {
    state = await source.ensure();
    if (state && state.version !== null) {
      lastVersion = state.version;
    }
  }

  const response = await forward(message);

  if (message.method === "initialize" && response && response.result) {
    patchInitialize(response);
    started = true;
    lastVersion = (await source.ensure())?.version ?? null;
    startVersionWatch();
  }

  if (!isNotification && response) {
    writeLine(message.method === "tools/list" ? withConnectedTools(response, state) : response);
  }
}

let watching = false;
function startVersionWatch() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (!started) return;
    const state = await source.ensure();
    if (state && state.version !== null && state.version !== lastVersion) {
      lastVersion = state.version;
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
