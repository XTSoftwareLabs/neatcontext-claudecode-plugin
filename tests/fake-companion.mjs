// A stand-in for the NeatContext desktop companion API, faithful to the
// documented contract: an in-memory connection (dropped by `restart()`, exactly
// as quitting the app does), a version counter, and an MCP endpoint whose
// get_context answers from the connection.

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

// What the app answers when it has nothing connected. It is written for the
// desktop client, where connecting is a button in the app — advice a Claude Code
// user cannot act on, and must never be handed. The plugin answers this case
// itself rather than forwarding it.
export const NO_CONTEXT_TEXT =
  "No NeatContext Context is connected. Open NeatContext, select a Context, and click " +
  "\"Connect Claude Desktop\", then ask again.";

// Stands in for the session instructions the desktop backend returns from
// initialize: a NeatContext-AI persona built around incident investigation,
// carrying the same reconnect advice the real one does — written for the desktop
// client, and forwarded here verbatim because the plugin does not rewrite what
// NeatContext says about its own contexts.
export const NEATCONTEXT_INSTRUCTIONS =
  "You are NeatContext AI, a local-first incident investigation assistant. " +
  "Always call get_context before answering an incident question. If no Context is " +
  "connected, stop and tell the user to reconnect from NeatContext.";

// The plugin's own routing tools. They ride on every tool list, so the tests
// that are about *extension* tools filter them out rather than restate them:
// what those tests protect is which context's tools are exposed, and routing
// tools belong to no context.
export const ROUTING_TOOL_NAMES = ["use_context", "preview_context"];

// Shuts a bridge process down the way Claude Code does — by closing its stdin —
// and waits for it to go. Killing it would work for the assertions, but a
// killed process never flushes its V8 coverage profile, and the diff-coverage
// gate is measured from what these child processes write on exit.
export function closeSession(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }
    child.once("exit", () => resolve());
    child.stdin.end();
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function startFakeCompanion({ contexts, token = "test-token" } = {}) {
  const state = {
    contexts: contexts ?? [
      { id: "ctx-payments", name: "payment team" },
      { id: "ctx-dokploy", name: "Dokploy" }
    ],
    connected: null,
    version: 0,
    // Survives `restart()`, like the runtime file NeatContext leaves on disk:
    // it is why a disconnected app can still list an old context's tools.
    lastRuntimeContext: null,
    puts: 0,
    // Makes the MCP surface answer tools/list and tools/call with an error, the
    // way a backend mid-restart does. The plugin decorates both of those, so it
    // has to cope with a response that carries no tools and no content.
    mcpError: false,
    // Makes the app refuse to connect a context it is perfectly willing to
    // list — a workspace that has been closed underneath it, say.
    refuseConnect: false,
    // Every `x-neatcontext-session` seen, in order. A real NeatContext keys its
    // connections by this; the plugin has to actually send it.
    sessionHeaders: [],
    // Connections keyed the way the app keys them, with `undefined` holding the
    // one it serves to clients that identify no session. `connected` stays as
    // the *requesting* session's view, which is what most tests assert on.
    bySession: new Map()
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = (request.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
      const method = (request.method ?? "GET").toUpperCase();
      const body = await readBody(request);
      const send = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(payload === undefined ? "" : JSON.stringify(payload));
      };

      if (method === "GET" && url === "/v1/health") {
        return send(200, { ok: true, app: "NeatContext", apiVersion: 1, appVersion: "test" });
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        return send(401, { error: "unauthorized" });
      }
      state.sessionHeaders.push(request.headers["x-neatcontext-session"]);
      if (method === "GET" && url === "/v1/contexts") {
        return send(200, {
          contexts: state.contexts,
          connected: state.connected,
          version: state.version
        });
      }
      if (url === "/v1/connection") {
        if (method === "GET") {
          return send(200, { connected: state.connected, version: state.version });
        }
        if (method === "PUT") {
          state.puts += 1;
          if (state.refuseConnect) return send(409, { error: "unavailable" });
          const context = state.contexts.find((entry) => entry.id === body?.contextId);
          if (!context) return send(404, { error: "unknown_context" });
          state.connected = { contextId: context.id, contextName: context.name };
          state.bySession.set(request.headers["x-neatcontext-session"], state.connected);
          state.lastRuntimeContext = context;
          state.version += 1;
          return send(200, { contextId: context.id, contextName: context.name });
        }
        if (method === "DELETE") {
          state.connected = null;
          state.version += 1;
          return send(204);
        }
      }
      if (method === "POST" && url === "/v1/mcp") {
        return send(200, mcpResponse(state, body));
      }
      return send(404, { error: "not_found" });
    })();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const directory = await mkdtemp(path.join(os.tmpdir(), "neatcontext-plugin-test-"));
  const discoveryFile = path.join(directory, "companion.json");
  await writeFile(discoveryFile, JSON.stringify({ port, token, apiVersion: 1 }));

  return {
    state,
    discoveryFile,
    directory,
    // Same effect as quitting and reopening NeatContext: the connection is gone,
    // the runtime file (and so the advertised tool list) is not.
    restart() {
      state.connected = null;
      state.version = 0;
    },
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

function mcpResponse(state, message) {
  const id = message?.id ?? null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  if (state.mcpError && message?.method !== "initialize") {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "backend unavailable" } };
  }
  if (message?.method === "initialize") {
    return ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "neatcontext-backend", version: "test" },
      instructions: NEATCONTEXT_INSTRUCTIONS
    });
  }
  if (message?.method === "tools/list") {
    const tools = [{ name: "get_context" }];
    if (state.lastRuntimeContext) {
      tools.push({ name: `demo_${state.lastRuntimeContext.id.replace(/-/g, "_")}` });
    }
    return ok({ tools });
  }
  // NeatContext serves an incident prompt; the plugin is expected to hide it.
  if (message?.method === "prompts/list") {
    return ok({
      prompts: [{ name: "analyze_incident" }, { name: "summarize_context" }]
    });
  }
  if (message?.method === "prompts/get") {
    return ok({
      messages: [{ role: "user", content: { type: "text", text: `prompt: ${message.params?.name}` } }]
    });
  }
  if (message?.method === "tools/call" && message.params?.name === "get_context") {
    const text = state.connected
      ? `Connected context: ${state.connected.contextName}`
      : NO_CONTEXT_TEXT;
    return ok({ content: [{ type: "text", text }], isError: false });
  }
  return ok({});
}
