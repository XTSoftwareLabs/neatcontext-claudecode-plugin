// Command-line entry the slash commands call. Prints human-readable text that
// the slash command relays to the user. Subcommands:
//
//   status                     show the connected context
//   list [--lite]              list contexts (standard from the app, plus lite)
//   use [query]                connect by number, exact name, or unique substring
//   create --name --knowledge  create a lite context (--profile-from <file>)
//   delete <query> [--yes]     delete a lite context
//   mode [auto|ask|manual]     how the session may route itself between contexts
//   describe <query> --use-when   record what a context should be routed for
//   alias <query> --called        record what the user calls a context
//
// Standard contexts are NeatContext desktop's and need the app open. Lite
// contexts are the plugin's own and work with the app closed, so every lite
// path here degrades gracefully instead of demanding the app.
//
// Exit code is always 0: the output is meant to be read, not branched on.

import { readFile } from "node:fs/promises";
import { clearSelection, ensureConnection, readSelection } from "./companion-client.mjs";
import {
  createLite,
  deleteLite,
  LiteContextError,
  listKnowledgeFiles,
  readProfileText
} from "./lite-context.mjs";
import {
  addAlias,
  isCardStale,
  MODES,
  putCard,
  readRouting,
  resolveMode,
  setMode
} from "./routing.mjs";
import { applySelection, listAllContexts, resolveContext } from "./selection.mjs";

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

function formatSection(title, contexts, offset, connectedId, emptyNote) {
  if (contexts.length === 0) {
    return `${title}\n  ${emptyNote}`;
  }
  const width = Math.max(...contexts.map((context) => context.name.length), 0);
  const rows = contexts.map((context, index) => {
    const marker = context.id === connectedId ? "  (connected)" : "";
    return `  ${offset + index + 1}. ${context.name.padEnd(width)}${marker}`.trimEnd();
  });
  return [title, ...rows].join("\n");
}

// Where the standard contexts went. Only worth saying when there are none to
// show: a populated list needs no explaining.
function noStandardNote(state) {
  if (!state.appRunning) {
    return "(none — open the NeatContext desktop app to use standard contexts)";
  }
  if (!state.appListed) {
    return "(none — NeatContext desktop is open but has no workspace loaded)";
  }
  return "(none — create one in the NeatContext desktop app)";
}

// The two kinds are listed apart, because they are different things: one comes
// from the desktop app, one is the plugin's own. The numbering runs continuously
// across both sections so `use <number>` still indexes the merged list the way
// the user is reading it.
function formatList(state) {
  const standard = state.contexts.filter((context) => context.kind === "standard");
  const connectedId = state.connected?.id ?? null;
  return [
    formatSection("Standard contexts:", standard, 0, connectedId, noStandardNote(state)),
    formatSection(
      "Lite contexts:",
      state.lite,
      standard.length,
      connectedId,
      "(none — create one with `/neatcontext:create`)"
    )
  ].join("\n\n");
}

function formatLiteList(state) {
  return formatSection(
    "Lite contexts:",
    state.lite,
    0,
    state.connected?.id ?? null,
    "(none — create one with `/neatcontext:create`)"
  );
}

// Everything the commands need about the world: both kinds of context, and what
// is connected. The connection is read through `ensureConnection` so a
// NeatContext restart — which drops the app's in-memory connection — is
// repaired here rather than reported as "no context is connected". A lite
// selection is authoritative on its own and needs no app at all.
async function loadState() {
  const selection = await readSelection();
  const { contexts, lite, standard, client, appListed } = await listAllContexts();

  let appState = null;
  if (client) {
    appState = await ensureConnection(client).catch(() => null);
    appState = appState ?? { connected: null, restored: false };
  }

  let connected = null;
  if (selection?.kind === "lite") {
    const record = lite.find((context) => context.id === selection.contextId) ?? null;
    const routing = await readRouting();
    connected = {
      kind: "lite",
      id: selection.contextId,
      name: record?.name ?? selection.contextName,
      record,
      stale: record
        ? isCardStale(routing.cards[selection.contextId], await readProfileText(record))
        : false
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
    contexts,
    lite,
    standard,
    connected,
    appRunning: Boolean(client),
    appListed,
    restoreFailed: appState?.restoreFailed === true
  };
}

async function commandStatus(state) {
  const { connected } = state;
  const routing = await readRouting();
  const mode = resolveMode(routing);
  // Reported alongside the connection because the two together are the whole
  // answer to "what is this session going to do": what it is grounded in, and
  // whether it may re-ground itself.
  const reportMode = () => {
    const staleCard = connected?.stale === true;
    print(`Context routing: ${mode} (change with \`/neatcontext:mode\`)`);
    if (staleCard) {
      print(
        "  This context's routing description was derived from an older version of its " +
          "profile. Ask me to refresh it."
      );
    }
  };

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
    reportMode();
    return;
  }

  if (connected) {
    print(
      connected.restored
        ? `Connected context: ${connected.name} (standard; NeatContext had restarted, the plugin reconnected it).`
        : `Connected context: ${connected.name} (standard)`
    );
    reportMode();
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
  reportMode();
}

function commandList(state, { liteOnly }) {
  print(liteOnly ? formatLiteList(state) : formatList(state));
}

async function commandUse(state, query) {
  const { contexts } = state;
  if (contexts.length === 0) {
    print("No contexts to connect.");
    print("");
    print(formatList(state));
    return;
  }
  if (query.length === 0) {
    print("Which context should I connect?");
    print("");
    print(formatList(state));
    return;
  }

  const resolution = resolveContext(contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    print("");
    print(formatList(state));
    return;
  }

  const target = resolution.context;
  const result = await applySelection(target, state.client);
  if (result.ok && result.kind === "lite") {
    print(
      `Connected the "${result.name}" lite context. Your next messages in this session ` +
        "will be grounded in its domain profile and knowledge folder."
    );
    await nudgeForDescription(target);
    return;
  }
  if (result.ok) {
    print(
      `Connected the "${result.name}" context. Your next messages ` +
        "in this session will be grounded in it."
    );
    await nudgeForDescription(target);
    return;
  }
  // No "the app is not running" case here: a standard context can only be
  // resolved from a list the app itself served, so by the time a target exists
  // the client does too. Only the app refusing the connection is left.
  print(`Could not connect "${target.name}". Try again from the app.`);
}

// A context with no routing description can only be routed to by name, which is
// what makes a standard context — whose profile the plugin cannot read until it
// is connected — much worse at routing than a lite one. Connecting is the
// moment that changes: the document is readable now, and the session that ran
// this command has a model to summarize it with. So the fix is to say so, here,
// and let the session do it.
async function nudgeForDescription(target) {
  const routing = await readRouting();
  if ((routing.cards[target.id]?.useWhen ?? "").length > 0) {
    return;
  }
  print("");
  print(
    "This context has no routing description yet, so it can only be routed to by name. " +
      "Derive one from what get_context returns, then record it with:"
  );
  print(`  neatcontext-cli.mjs describe "${target.name}" --use-when "<one line of scope>"`);
}

// Stores a routing description for a context that already exists. The line
// itself is written by the session's model — this only records it, against the
// text it was derived from so drift can be spotted later.
async function commandDescribe(state, query, flags) {
  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    return;
  }
  const useWhen = typeof flags["use-when"] === "string" ? flags["use-when"] : "";
  if (useWhen.trim().length === 0) {
    print("Pass the routing description with --use-when.");
    return;
  }
  let source;
  if (resolution.context.kind === "lite") {
    source = (await readProfileText(resolution.context)) ?? undefined;
  }
  const card = await putCard(resolution.context.id, { useWhen, source });
  print(`"${resolution.context.name}" now routes for: ${card.useWhen}`);
}

// Naming a context by hand is also the clearest correction signal there is: the
// user is overriding whatever the session would have picked. `--called` records
// the words they used for it, so the next session routes them correctly without
// being told twice.
async function commandAlias(state, query, flags) {
  const resolution = resolveContext(state.contexts, query);
  if (resolution.error) {
    print(`No single context matched "${query}".`);
    return;
  }
  const alias = typeof flags.called === "string" ? flags.called : "";
  const recorded = await addAlias(resolution.context.id, alias);
  if (!recorded) {
    print("Pass the words to remember with --called.");
    return;
  }
  print(`Noted — "${recorded}" now routes to "${resolution.context.name}".`);
}

async function commandMode(query) {
  const routing = await readRouting();
  if (query.length === 0) {
    print(`Context routing is ${resolveMode(routing)}.`);
    print("");
    print("  auto    switch context on a clear match, and say so; ask when it is a close call");
    print("  ask     always ask before switching (default)");
    print("  manual  never route — /neatcontext:use only");
    print("");
    print(`Change it with \`/neatcontext:mode <${MODES.join("|")}>\`.`);
    return;
  }

  const wanted = query.trim().toLowerCase();
  if (!MODES.includes(wanted)) {
    print(`"${query}" is not a mode. Use one of: ${MODES.join(", ")}.`);
    return;
  }
  await setMode(wanted);
  print(`Context routing is now ${wanted}.`);
  if (wanted === "auto") {
    // One connected context per machine, so a switch is felt by every open
    // window. Auto mode is what makes that happen often rather than rarely.
    print(
      "The session will switch context on its own and tell you when it does. Every open " +
        "Claude Code window shares one connected context, so a switch here changes theirs too."
    );
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
    const { record, profileText, knowledgeFileCount } = await createLite({
      name,
      knowledgeFolder: knowledge,
      profile
    });
    // The routing line is derived from the profile by the model that ran this
    // command, and stored against the profile it was derived from: edit the
    // profile later and the hash stops matching, which is how a session finds
    // out the line now describes something the context no longer is.
    //
    // `profileText`, not `profile` — the stored profile is normalized, and
    // hashing the input would make every context stale from the moment it was
    // created.
    const useWhen = typeof flags["use-when"] === "string" ? flags["use-when"] : "";
    await putCard(record.id, { useWhen, source: profileText });
    print(`Created the "${record.name}" lite context.`);
    print(`  Domain profile:   ${record.profilePath}`);
    if (useWhen.trim().length > 0) {
      print(`  Routes here for:  ${useWhen.trim()}`);
    }
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
    print("Which lite context should I delete?");
    print("");
    print(formatLiteList(state));
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
    print(`No single lite context matched "${query}".`);
    print("");
    print(formatLiteList(state));
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
  // Reads no context list and touches no connection: the one command that still
  // answers with the desktop app closed and nothing created yet.
  if (command === "mode") {
    await commandMode(query);
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
  if (command === "alias") {
    await commandAlias(state, query, flags);
    return;
  }
  if (command === "describe") {
    await commandDescribe(state, query, flags);
    return;
  }
  print(
    `Unknown command "${command}". ` +
      "Use: status | list | use | create | delete | mode | alias | describe."
  );
}

run()
  .catch((error) => {
    print(`NeatContext plugin error: ${error?.message ?? error}`);
  })
  .finally(() => process.exit(0));
