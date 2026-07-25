// A stand-in for the NeatContext desktop companion API, faithful to the
// documented contract: an in-memory connection (dropped by `restart()`, exactly
// as quitting the app does), a version counter, and an MCP endpoint whose
// get_context answers from the connection.

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

export const NO_CONTEXT_TEXT =
  "No NeatContext Context is connected to this session. Run /neatcontext:use to " +
  "choose one, then ask again.";

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
    puts: 0
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
          const context = state.contexts.find((entry) => entry.id === body?.contextId);
          if (!context) return send(404, { error: "unknown_context" });
          state.connected = { contextId: context.id, contextName: context.name };
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
  if (message?.method === "initialize") {
    return ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "neatcontext-backend", version: "test" }
    });
  }
  if (message?.method === "tools/list") {
    const tools = [{ name: "get_context" }];
    if (state.lastRuntimeContext) {
      tools.push({ name: `demo_${state.lastRuntimeContext.id.replace(/-/g, "_")}` });
    }
    return ok({ tools });
  }
  if (message?.method === "tools/call" && message.params?.name === "get_context") {
    const text = state.connected
      ? `Connected context: ${state.connected.contextName}`
      : NO_CONTEXT_TEXT;
    return ok({ content: [{ type: "text", text }], isError: false });
  }
  return ok({});
}
