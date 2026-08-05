// Turning declarations plus bindings into tools the session can actually call.
//
// This is the only place the two halves meet. A context says "I expect an
// extension called `pagerduty`, and I want its incident tools"; the machine says
// "`pagerduty` here means this command"; and what comes out is a list of tools
// named `pagerduty__list_incidents` that the connected session may call, and a
// status line for every declaration that did not get that far.
//
// Two rules shape the rest of the file.
//
// The context narrows, never widens. A declaration can only ever reach an
// extension the user bound on this machine, and only the tools that extension
// actually offers. Naming a tool that is not there produces a note, not a
// capability. There is no path by which a context grants itself something the
// local configuration did not already allow.
//
// Extensions are never load-bearing. Everything here is allowed to fail — the
// binding may be missing, the command may not exist, the server may hang, it may
// die mid-session — and in every one of those cases the caller still gets the
// context. Grounding is the profile and the knowledge folder; extensions are an
// addition to it, and their absence is reported rather than raised.

import { readBindings, resolveBinding } from "./extension-bindings.mjs";
import { parseQualifiedToolName, qualifiedToolName, selectDeclaredTools } from "./extensions.mjs";
import { createStdioMcpClient } from "./mcp-stdio-client.mjs";

// How long a dead extension is left alone before another connection is
// attempted. Without this, a binding pointing at a command that does not exist
// would be spawned again on every tools/list.
const RETRY_AFTER_MS = 30_000;

export function createExtensionHost({
  createClient = createStdioMcpClient,
  loadBindings = readBindings,
  now = () => Date.now()
} = {}) {
  let contextId = null;
  let connections = new Map();
  let lastStatuses = [];

  function disposeConnections() {
    for (const connection of connections.values()) {
      connection.client?.close();
    }
    connections = new Map();
  }

  async function connect(declaration, spec) {
    const existing = connections.get(declaration.id);
    if (existing?.client) {
      // Still up: reuse it. Gone: it ran once, so start it again now rather than
      // waiting — a server that crashed on one call is usually fine on the next.
      if (!existing.client.closed) return existing;
      connections.delete(declaration.id);
    } else if (existing && now() - existing.failedAt < RETRY_AFTER_MS) {
      // It never started. That is a configuration problem, not a blip, so stop
      // spawning it on every tools/list until the backoff has passed.
      return existing;
    }

    const client = createClient(spec);
    try {
      await client.initialize();
      const offered = await client.listTools();
      const connection = { client, offered, failedAt: 0, detail: null };
      connections.set(declaration.id, connection);
      return connection;
    } catch (error) {
      client.close();
      const connection = {
        client: null,
        offered: [],
        failedAt: now(),
        detail: error?.message ?? "the extension could not be started"
      };
      connections.set(declaration.id, connection);
      return connection;
    }
  }

  async function resolve(record) {
    if (!record) {
      disposeConnections();
      contextId = null;
      lastStatuses = [];
      return { statuses: [], tools: [] };
    }
    if (record.id !== contextId) {
      // A different context is connected now. Nothing it did not declare should
      // still be running, and nothing the previous one started should be
      // reachable from it.
      disposeConnections();
      contextId = record.id;
    }
    const declarations = record.extensions ?? [];
    if (declarations.length === 0) {
      disposeConnections();
      lastStatuses = [];
      return { statuses: [], tools: [] };
    }

    const { bindings } = await loadBindings();
    const statuses = [];
    const tools = [];

    for (const declaration of declarations) {
      const resolution = resolveBinding(declaration, bindings, record);
      if (resolution.status !== "bound") {
        statuses.push({
          id: declaration.id,
          capability: declaration.capability,
          importance: declaration.importance,
          status: "unconfigured",
          detail: resolution.detail,
          tools: []
        });
        continue;
      }

      const connection = await connect(declaration, resolution.spec);
      if (!connection.client) {
        statuses.push({
          id: declaration.id,
          capability: declaration.capability,
          importance: declaration.importance,
          // Never started, or started and then stopped. Both mean the same thing
          // to the session: this capability is not there right now.
          status: connection.offered.length > 0 ? "failed" : "unavailable",
          detail: connection.detail,
          tools: []
        });
        continue;
      }

      const { selected, missing } = selectDeclaredTools(declaration, connection.offered);
      for (const tool of selected) {
        tools.push({
          name: qualifiedToolName(declaration.id, tool.name),
          title: tool.title,
          description: extensionToolDescription(declaration, tool),
          inputSchema: tool.inputSchema ?? {
            type: "object",
            properties: {},
            additionalProperties: true
          }
        });
      }
      statuses.push({
        id: declaration.id,
        capability: declaration.capability,
        importance: declaration.importance,
        status: selected.length > 0 ? "ready" : "unavailable",
        detail:
          selected.length === 0
            ? `"${declaration.id}" is running but offers none of the tools this context asked for.`
            : missing.length > 0
              ? `Not offered by this extension: ${missing.join(", ")}.`
              : null,
        tools: selected.map((tool) => qualifiedToolName(declaration.id, tool.name))
      });
    }

    lastStatuses = statuses;
    return { statuses, tools };
  }

  // Proxying a call. The name carries the extension it belongs to, so the check
  // that it belongs to the connected context is a lookup rather than trust.
  async function call(name, args) {
    const parsed = parseQualifiedToolName(name);
    if (!parsed) return null;
    const status = lastStatuses.find((entry) => entry.id === parsed.extensionId);
    if (!status || !status.tools.includes(name)) return null;
    const connection = connections.get(parsed.extensionId);
    if (!connection?.client || connection.client.closed) {
      return {
        content: [
          {
            type: "text",
            text:
              `The "${parsed.extensionId}" extension is not running, so ${name} could not be ` +
              "called. Tell the user, and answer from the context's profile and knowledge instead."
          }
        ],
        isError: true
      };
    }
    try {
      return await connection.client.callTool(parsed.toolName, args);
    } catch (error) {
      connection.client.close();
      connections.set(parsed.extensionId, {
        client: null,
        offered: connection.offered,
        failedAt: now(),
        detail: error?.message ?? "the call failed"
      });
      return {
        content: [
          {
            type: "text",
            text:
              `The "${parsed.extensionId}" extension failed while serving ${name}: ` +
              `${error?.message ?? "the call failed"}. Tell the user, and answer from the ` +
              "context's profile and knowledge instead."
          }
        ],
        isError: true
      };
    }
  }

  // What the host's tool list depends on, computed without starting anything.
  // The declared ids catch a context switch; the resolved names catch an
  // extension that only became reachable after the last list.
  function signature(record) {
    const declared = (record?.extensions ?? []).map((declaration) => declaration.id).join(",");
    const ready = lastStatuses
      .flatMap((status) => status.tools)
      .sort()
      .join(",");
    return `${declared}|${ready}`;
  }

  return {
    resolve,
    call,
    signature,
    statuses: () => lastStatuses,
    dispose: () => {
      disposeConnections();
      contextId = null;
      lastStatuses = [];
    }
  };
}

// The session sees this instead of the extension's own description alone. The
// context's capability line is what says why this tool is here at all, and the
// session is choosing between tools, not reading documentation.
function extensionToolDescription(declaration, tool) {
  const own = typeof tool.description === "string" ? tool.description.trim() : "";
  const lead = `From the "${declaration.id}" extension of this context — ${declaration.capability}`;
  return own.length > 0 ? `${lead}\n\n${own}` : lead;
}

// What get_context says about the extensions this context expects. Present only
// when it expects some, and phrased so an unconfigured one reads as a thing the
// user can fix rather than as a failure of the answer.
export function renderExtensionStatus(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return "";
  const lines = ["## Extensions this context expects", ""];
  const ready = statuses.filter((status) => status.status === "ready");
  for (const status of statuses) {
    const label =
      status.status === "ready"
        ? "ready"
        : status.status === "unconfigured"
          ? "not configured on this machine"
          : status.status === "unavailable"
            ? "unavailable"
            : "failed";
    lines.push(`- **${status.id}** (${label}) — ${status.capability}`);
    if (status.status === "ready") {
      lines.push(`  - Call it with: ${status.tools.join(", ")}`);
      if (status.detail) lines.push(`  - ${status.detail}`);
    } else {
      lines.push(`  - ${status.detail ?? "No further detail."}`);
    }
  }
  lines.push("");
  if (ready.length === 0) {
    lines.push(
      "None of them are available right now. Answer from the domain profile and the knowledge " +
        "folder, and say plainly which capability was missing if it would have changed the answer."
    );
  } else {
    lines.push(
      "Use these tools when the question needs live data from the system they reach. They are " +
        "part of this context and are not available once you switch away from it. When one of " +
        "them fails, say so rather than guessing at what it would have returned."
    );
  }
  return lines.join("\n");
}
