// Command-line entry the slash commands call. Prints human-readable text that
// the slash command relays to the user. Subcommands:
//
//   status                     show the connected context
//   list [--lite]              list contexts (standard from the app, plus lite)
//   use [query]                connect by number, exact name, or unique substring
//   create --name --knowledge  create a lite context (--profile-from <file>)
//   delete <query> [--yes]     delete a lite context
//
// Standard contexts are NeatContext desktop's and need the app open. Lite
// contexts are the plugin's own and work with the app closed, so every lite
// path here degrades gracefully instead of demanding the app.
//
// Exit code is always 0: the output is meant to be read, not branched on.

import { readFile } from "node:fs/promises";
import {
  clearSelection,
  connect,
  ensureConnection,
  NOT_RUNNING_MESSAGE,
  readSelection,
  writeSelection
} from "./companion-client.mjs";
import {
  createLite,
  deleteLite,
  LiteContextError,
  listKnowledgeFiles,
  listLite
} from "./lite-context.mjs";

const UPGRADE_NOTE =
  "A lite context holds one domain profile and one knowledge folder. For multiple " +
  "knowledge folders, extension tools (incidents, logs, deploys), and indexed " +
  "retrieval, create a standard context in the NeatContext desktop app.";

function print(line = "") {
  process.stdout.write(`${line}\n`);
}

// `--name value`, `--name=value`, and bare `--flag` booleans.
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, query: rest.join(" ").trim() };
}

function label(context) {
  return context.kind === "lite" ? "lite" : "standard";
}

function formatList(contexts, connectedId) {
  const width = Math.max(...contexts.map((context) => context.name.length), 0);
  return contexts
    .map((context, index) => {
      const tags = [label(context)];
      if (context.id === connectedId) {
        tags.push("connected");
      }
      return `  ${index + 1}. ${context.name.padEnd(width)}  (${tags.join(", ")})`;
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
  const partial = contexts.filter((context) => context.name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { context: partial[0] };
  }
  return { error: partial.length > 1 || exact.length > 1 ? "ambiguous" : "not_found" };
}

// Everything the commands need about the world: both kinds of context, and what
// is connected. The connection is read through `ensureConnection` so a
// NeatContext restart — which drops the app's in-memory connection — is
// repaired here rather than reported as "no context is connected". A lite
// selection is authoritative on its own and needs no app at all.
async function loadState() {
  const selection = await readSelection();
  const lite = (await listLite()).map((context) => ({ ...context, kind: "lite" }));

  const client = await connect();
  let standard = [];
  let appState = null;
  let appListed = false;
  if (client) {
    appState = await ensureConnection(client).catch(() => null);
    const response = await client.listContexts();
    if (response.status === 200) {
      appListed = true;
      standard = (response.json?.contexts ?? []).map((context) => ({ ...context, kind: "standard" }));
      appState = appState ?? {
        connected: response.json?.connected ?? null,
        restored: false
      };
    }
  }

  let connected = null;
  if (selection?.kind === "lite") {
    const record = lite.find((context) => context.id === selection.contextId) ?? null;
    connected = {
      kind: "lite",
      id: selection.contextId,
      name: record?.name ?? selection.contextName,
      record
    };
  } else if (appState?.connected) {
    const id = appState.connected.contextId;
    connected = {
      kind: "standard",
      id,
      name: standard.find((context) => context.id === id)?.name ?? appState.connected.contextName ?? id,
      restored: appState.restored === true
    };
  }

  return {
    client,
    contexts: [...standard, ...lite],
    lite,
    connected,
    appRunning: Boolean(client),
    appListed,
    restoreFailed: appState?.restoreFailed === true
  };
}

function appMissingNote(state) {
  if (state.appRunning && state.appListed) {
    return null;
  }
  return state.appRunning
    ? "Standard contexts aren't listed: NeatContext desktop is running but no workspace is open."
    : "Standard contexts aren't listed: the NeatContext desktop app isn't running.";
}

async function commandStatus(state) {
  const { connected } = state;
  if (connected?.kind === "lite") {
    if (!connected.record) {
      print(
        `The lite context "${connected.name}" is connected but is no longer on disk. ` +
          "Use `/neatcontext:list` to pick another, or `/neatcontext:create` to make a new one."
      );
      return;
    }
    print(`Connected context: ${connected.name} (lite)`);
    print(`  Domain profile:   ${connected.record.profilePath}`);
    const folder = connected.record.knowledgeFolder;
    const { files } = await listKnowledgeFiles(folder);
    print(`  Knowledge folder: ${folder}${files.length > 0 ? ` (${files.length} files)` : ""}`);
    if (files.length === 0) {
      print(
        "  The knowledge folder is empty or missing — put TSGs, runbooks, or docs in it, " +
          "or check the path is still valid."
      );
    }
    print("  Lite contexts have no extension tools.");
    return;
  }

  if (connected) {
    print(
      connected.restored
        ? `Connected context: ${connected.name} (standard; NeatContext had restarted, the plugin reconnected it).`
        : `Connected context: ${connected.name} (standard)`
    );
    return;
  }

  if (state.restoreFailed) {
    print(
      "The context this session was using is no longer available in NeatContext. " +
        "Use `/neatcontext:use` to pick another one."
    );
    return;
  }
  print("No context is connected yet. Use `/neatcontext:use` to pick one.");
}

function commandList(state, { liteOnly }) {
  const contexts = liteOnly ? state.lite : state.contexts;
  const connectedId = state.connected?.id ?? null;

  if (contexts.length === 0) {
    if (liteOnly) {
      print("You have no lite contexts. Create one with `/neatcontext:create`.");
      return;
    }
    print("No contexts yet. Create a lite context with `/neatcontext:create`.");
    const note = appMissingNote(state);
    if (note) {
      print(note);
    }
    print(UPGRADE_NOTE);
    return;
  }

  print(liteOnly ? "Your lite contexts:" : "Available contexts:");
  print(formatList(contexts, connectedId));
  if (!liteOnly) {
    const note = appMissingNote(state);
    if (note) {
      print(note);
    }
  }
}

async function commandUse(state, query) {
  const { contexts } = state;
  if (contexts.length === 0) {
    print("No contexts to connect. Create a lite context with `/neatcontext:create`.");
    const note = appMissingNote(state);
    if (note) {
      print(note);
    }
    return;
  }
  if (query.length === 0) {
    print("Which context should I connect? Available contexts:");
    print(formatList(contexts, state.connected?.id ?? null));
    return;
  }

  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}". Available contexts:`);
    print(formatList(contexts, state.connected?.id ?? null));
    const note = appMissingNote(state);
    if (note) {
      print(note);
    }
    return;
  }

  const target = resolution.context;
  if (target.kind === "lite") {
    // The app must not stay bound to a standard context while a lite one is
    // selected, or the two sources disagree about what is grounded.
    if (state.client) {
      await state.client.disconnect().catch(() => undefined);
    }
    // `liteContextId`, not `contextId`: see selectionFilePath() for why a lite
    // selection has to be invisible to pre-lite plugin processes.
    await writeSelection({ kind: "lite", liteContextId: target.id, contextName: target.name });
    print(
      `Connected the "${target.name}" lite context. Your next messages in this session ` +
        "will be grounded in its domain profile and knowledge folder."
    );
    return;
  }

  if (!state.client) {
    print(NOT_RUNNING_MESSAGE);
    return;
  }
  const selection = await state.client.selectContext(target.id);
  if (selection.status === 200) {
    // Remembered so the bridge can put the connection back if NeatContext is
    // restarted while this session is still open.
    await writeSelection({
      kind: "standard",
      contextId: target.id,
      contextName: selection.json.contextName ?? target.name
    }).catch(() => undefined);
    print(
      `Connected the "${selection.json.contextName}" context. Your next messages ` +
        "in this session will be grounded in it."
    );
  } else {
    print(`Could not connect "${target.name}". Try again from the app.`);
  }
}

async function commandCreate(flags) {
  const name = typeof flags.name === "string" ? flags.name : "";
  const knowledge = typeof flags.knowledge === "string" ? flags.knowledge : "";
  let profile = typeof flags.profile === "string" ? flags.profile : "";

  // Prose arrives by file, not argv: multi-line profiles do not survive shell
  // quoting on either platform.
  if (typeof flags["profile-from"] === "string") {
    try {
      profile = await readFile(flags["profile-from"], "utf8");
    } catch {
      print(`Could not read the profile file at ${flags["profile-from"]}.`);
      return;
    }
  }

  try {
    const { record, knowledgeFileCount } = await createLite({ name, knowledgeFolder: knowledge, profile });
    print(`Created the "${record.name}" lite context.`);
    print(`  Domain profile:   ${record.profilePath}`);
    print(
      `  Knowledge folder: ${record.knowledgeFolder}` +
        (knowledgeFileCount > 0 ? ` (${knowledgeFileCount} files)` : " (empty for now)")
    );
    print(`  Connect it with:  /neatcontext:use ${record.name}`);
    if (knowledgeFileCount === 0) {
      print("The folder has no files yet — put the TSGs, runbooks, or docs in it before asking questions.");
    }
    print(UPGRADE_NOTE);
  } catch (error) {
    if (error instanceof LiteContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

async function commandDelete(state, query, flags) {
  if (query.length === 0) {
    print("Which lite context should I delete? Your lite contexts:");
    print(
      state.lite.length > 0
        ? formatList(state.lite, state.connected?.id ?? null)
        : "  (none — create one with `/neatcontext:create`)"
    );
    return;
  }

  const resolution = resolveContext(state.lite, query);
  if (resolution.error) {
    // Standard contexts are the desktop app's to manage; say so specifically
    // rather than "not found", which reads as a bug when the name is right there
    // in the list.
    const standardMatch = state.contexts.find(
      (context) => context.kind === "standard" && context.name.toLowerCase().includes(query.toLowerCase())
    );
    if (standardMatch) {
      print(
        `"${standardMatch.name}" is a standard context. Only lite contexts can be deleted ` +
          "from here — delete standard ones in the NeatContext desktop app."
      );
      return;
    }
    print(`No single lite context matched "${query}". Your lite contexts:`);
    print(
      state.lite.length > 0
        ? formatList(state.lite, state.connected?.id ?? null)
        : "  (none — create one with `/neatcontext:create`)"
    );
    return;
  }

  const target = resolution.context;
  if (flags.yes !== true && flags.yes !== "true") {
    print(`This will delete the "${target.name}" lite context:`);
    print(`  ${target.directory}`);
    print(`Its knowledge folder (${target.knowledgeFolder}) will NOT be touched.`);
    print("Re-run with --yes to confirm.");
    return;
  }

  const deleted = await deleteLite(target.id);
  if (!deleted) {
    print(`The "${target.name}" lite context was already gone.`);
    return;
  }
  print(`Deleted the "${deleted.name}" lite context.`);
  print(`Its knowledge folder (${deleted.knowledgeFolder}) was left untouched.`);
  if (state.connected?.id === deleted.id) {
    await clearSelection();
    print("It was the connected context, so this session is no longer grounded in one.");
  }
}

async function run() {
  const [command = "status", ...rest] = process.argv.slice(2);
  const { flags, query } = parseArgs(rest);

  if (command === "create") {
    await commandCreate(flags);
    return;
  }

  const state = await loadState();

  if (command === "status") {
    await commandStatus(state);
    return;
  }
  if (command === "list") {
    commandList(state, { liteOnly: flags.lite === true || flags.lite === "true" });
    return;
  }
  if (command === "use") {
    await commandUse(state, query);
    return;
  }
  if (command === "delete") {
    await commandDelete(state, query, flags);
    return;
  }

  print(`Unknown command "${command}". Use: status | list | use | create | delete.`);
}

run()
  .catch((error) => {
    print(`NeatContext plugin error: ${error?.message ?? error}`);
  })
  .finally(() => process.exit(0));
