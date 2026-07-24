// Command-line entry the slash commands call. Prints human-readable text that
// the slash command relays to the user. Subcommands:
//
//   status         show whether NeatContext is running and the connected context
//   list           list the available contexts
//   use [query]    connect a context by number, exact name, or unique substring;
//                  with no query (or an ambiguous one) it prints the choices
//
// Exit code is always 0: the output is meant to be read, not branched on.

import { connect, NOT_RUNNING_MESSAGE } from "./companion-client.mjs";

function print(line = "") {
  process.stdout.write(`${line}\n`);
}

function formatList(contexts, connectedId) {
  return contexts
    .map((context, index) => {
      const marker = context.id === connectedId ? " (connected)" : "";
      return `  ${index + 1}. ${context.name}${marker}`;
    })
    .join("\n");
}

function resolveContext(contexts, query) {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) {
    const context = contexts[Number(trimmed) - 1];
    return context ? { context } : { error: "out_of_range" };
  }
  const lower = trimmed.toLowerCase();
  const exact = contexts.filter((context) => context.name.toLowerCase() === lower);
  if (exact.length === 1) {
    return { context: exact[0] };
  }
  const partial = contexts.filter((context) =>
    context.name.toLowerCase().includes(lower)
  );
  if (partial.length === 1) {
    return { context: partial[0] };
  }
  return { error: partial.length > 1 ? "ambiguous" : "not_found" };
}

async function loadContexts(client) {
  const response = await client.listContexts();
  if (response.status !== 200) {
    return null;
  }
  return {
    contexts: response.json?.contexts ?? [],
    connectedId: response.json?.connected?.contextId ?? null
  };
}

async function run() {
  const [command = "status", ...rest] = process.argv.slice(2);
  const query = rest.join(" ").trim();

  const client = await connect();
  if (!client) {
    print(NOT_RUNNING_MESSAGE);
    return;
  }

  const state = await loadContexts(client);
  if (!state) {
    print("Could not read contexts from NeatContext. Is a workspace open in the app?");
    return;
  }
  const { contexts, connectedId } = state;

  if (command === "status") {
    if (connectedId) {
      const current = contexts.find((context) => context.id === connectedId);
      print(`Connected context: ${current ? current.name : connectedId}`);
    } else {
      print("No context is connected yet. Use `/neatcontext:use` to pick one.");
    }
    return;
  }

  if (contexts.length === 0) {
    print("NeatContext has no contexts yet. Create one in the desktop app first.");
    return;
  }

  if (command === "list") {
    print("Available NeatContext contexts:");
    print(formatList(contexts, connectedId));
    return;
  }

  if (command === "use") {
    if (query.length === 0) {
      print("Which context should I connect? Available contexts:");
      print(formatList(contexts, connectedId));
      return;
    }
    const resolution = resolveContext(contexts, query);
    if (resolution.error) {
      print(`No single context matched "${query}". Available contexts:`);
      print(formatList(contexts, connectedId));
      return;
    }
    const selection = await client.selectContext(resolution.context.id);
    if (selection.status === 200) {
      print(
        `Connected the "${selection.json.contextName}" context. Your next messages ` +
          "in this session will be grounded in it."
      );
    } else {
      print(`Could not connect "${resolution.context.name}". Try again from the app.`);
    }
    return;
  }

  print(`Unknown command "${command}". Use: status | list | use [context].`);
}

run()
  .catch((error) => {
    print(`NeatContext plugin error: ${error?.message ?? error}`);
  })
  .finally(() => process.exit(0));
