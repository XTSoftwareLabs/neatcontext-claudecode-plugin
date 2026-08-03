// Command-line entry the slash commands call. Prints human-readable text that
// the slash command relays to the user. Subcommands:
//
//   status                     show the connected context
//   list [--lite]              list contexts (standard from the app, plus lite)
//   use [query]                connect by number, exact name, or unique substring
//   disconnect                 disconnect the context from this session
//   create --name --knowledge  create a lite context (--profile-from <file>)
//   save-target [name]          decide whether save creates or updates
//   save --from <capture.json>  create or update from this conversation
//   import --from <bundle>      import a portable conversation context
//   export --to <folder>        copy a saved context's bundle out for sharing
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

import { readFile, rm } from "node:fs/promises";
import "./session.mjs";
import { clearSelection, ensureConnection, readSelection } from "../core/companion-client.mjs";
import {
  createCapturedLite,
  createLite,
  deleteLite,
  exportLite,
  fingerprintLite,
  importCapturedLite,
  LiteContextError,
  listKnowledgeFiles,
  previewCapturedLiteUpdate,
  readProfileText,
  updateCapturedLite
} from "../core/lite-context.mjs";
import {
  addAlias,
  isCardStale,
  MODES,
  putCard,
  readRouting,
  resolveMode,
  sessionId,
  setMode
} from "../core/routing.mjs";
import { noteSaved } from "../core/save-nudge.mjs";
import {
  applySelection,
  disconnectSelection,
  listAllContexts,
  resolveContext
} from "../core/selection.mjs";

const UPGRADE_NOTE =
  "A lite context holds one domain profile, one primary knowledge folder, and saved " +
  "conversation notes. For multiple linked knowledge folders, extension tools " +
  "(incidents, logs, deploys), and indexed " +
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

// Why the standard contexts are missing is not worth three different sentences:
// app closed, no workspace loaded, and none created all lead the user to the
// same place. One line covers every case.
const NO_STANDARD_NOTE =
  "(none — make sure the NeatContext desktop app is installed and running)";

// The two kinds are listed apart, because they are different things: one is the
// plugin's own, one comes from the desktop app. Lite goes first — it is the half
// that is always there. The numbering runs continuously across both sections so
// `use <number>` still indexes the merged list the way the user is reading it.
function formatList(state) {
  const standard = state.contexts.filter((context) => context.kind === "standard");
  const connectedId = state.connected?.id ?? null;
  return [
    formatSection(
      "Lite contexts:",
      state.lite,
      0,
      connectedId,
      "(none — create one with `/neatcontext:create`)"
    ),
    formatSection("Standard contexts:", standard, state.lite.length, connectedId, NO_STANDARD_NOTE)
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
  const { contexts, lite, standard, client } = await listAllContexts();

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
    selection,
    connected,
    restoreFailed: appState?.restoreFailed === true
  };
}

async function commandStatus(state) {
  const { connected } = state;
  const routing = await readRouting();
  const mode = resolveMode(routing, sessionId());
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
    if (!connected.record.knowledgeManaged && connected.record.conversationKnowledgeFolder) {
      const generated = await listKnowledgeFiles(connected.record.conversationKnowledgeFolder);
      if (generated.files.length > 0) {
        print(
          `  Conversation knowledge: ${connected.record.conversationKnowledgeFolder} ` +
            `(${generated.files.length} files)`
        );
      }
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

function saveNameKey(value) {
  return value.trim().toLowerCase();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function similarSaveTargets(contexts, query) {
  const wanted = saveNameKey(query).replace(/[^a-z0-9]+/g, "");
  if (wanted.length < 3) {
    return [];
  }
  return contexts.filter((context) => {
    const candidate = saveNameKey(context.name).replace(/[^a-z0-9]+/g, "");
    if (candidate.includes(wanted) || wanted.includes(candidate)) {
      return true;
    }
    return (
      editDistance(wanted, candidate) <=
      Math.max(2, Math.floor(Math.max(wanted.length, candidate.length) * 0.2))
    );
  });
}

async function printUpdateTarget(target) {
  const routing = await readRouting();
  const useWhen = routing.cards[target.id]?.useWhen || target.routingDescription;
  print("Save action: update");
  print(`Context name: ${target.name}`);
  print(`Context id: ${target.id}`);
  print(`Base hash: ${await fingerprintLite(target)}`);
  print(`Profile path: ${target.profilePath}`);
  print(`Routing description: ${useWhen || "(none — derive one from the profile)"}`);
  print(`Knowledge folder: ${target.knowledgeFolder}`);
  if (target.knowledgeManaged) {
    print(`Conversation knowledge folder: ${target.knowledgeFolder}`);
    print("Knowledge ownership: managed by this lite context");
  } else {
    print(`Conversation knowledge folder: ${target.conversationKnowledgeFolder}`);
    print(
      "Knowledge ownership: linked folder is read-only; conversation updates are bundle-local"
    );
  }
}

// Save deliberately resolves names more strictly than `/use`: an exact,
// case-insensitive name updates, while a genuinely new name creates. Partial
// matching would turn "save as" into a surprising mutation.
async function commandSaveTarget(state, query) {
  if (query.length === 0) {
    if (state.connected?.kind === "lite" && state.connected.record) {
      await printUpdateTarget(state.connected.record);
      return;
    }
    if (state.selection?.kind === "lite") {
      print("Save action: unavailable");
      print(
        `The connected lite context "${state.selection.contextName}" no longer exists on disk.`
      );
      print("Connect another context or provide a new context name.");
      return;
    }
    if (state.connected?.kind === "standard" || state.selection?.kind === "standard") {
      const name = state.connected?.name ?? state.selection.contextName;
      print("Save action: unavailable");
      print(
        `The connected context "${name}" is a standard context and cannot be updated by this plugin.`
      );
      print("Provide a new name to save this conversation as a lite context.");
      return;
    }
    print("Save action: create");
    print("Context name: derive a short, specific name from the conversation");
    return;
  }

  const candidates = [...state.contexts];
  if (
    state.selection &&
    !candidates.some((context) => context.id === state.selection.contextId)
  ) {
    candidates.push({
      id: state.selection.contextId,
      name: state.selection.contextName,
      kind: state.selection.kind,
      missing: true
    });
  }

  const exact = candidates.filter(
    (context) => saveNameKey(context.name) === saveNameKey(query)
  );
  if (exact.length > 1) {
    print("Save action: choose");
    print(`More than one context is named "${query}".`);
    for (const context of exact) {
      print(`  ${context.name} (${context.kind})`);
    }
    print("Choose a distinct new name or resolve the duplicate before saving.");
    return;
  }
  if (exact.length === 1) {
    const target = exact[0];
    if (target.missing && target.kind === "lite") {
      print("Save action: unavailable");
      print(`The lite context "${target.name}" no longer exists on disk.`);
      print("Choose a new context name or connect another lite context.");
      return;
    }
    if (target.kind !== "lite") {
      print("Save action: unavailable");
      print(
        `The existing context "${target.name}" is a standard context and cannot be updated by this plugin.`
      );
      print("Choose a different name to create a lite context.");
      return;
    }
    await printUpdateTarget(target);
    return;
  }

  const similar = similarSaveTargets(candidates, query);
  if (similar.length > 0) {
    print("Save action: choose");
    print(`No context is named exactly "${query}", but these names are similar:`);
    for (const context of similar) {
      print(`  ${context.name} (${context.kind})`);
    }
    print(`Confirm whether to create "${query}", or use an exact existing name to update it.`);
    return;
  }

  print("Save action: create");
  print(`Context name: ${query}`);
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

async function commandDisconnect(state) {
  const connected = state.connected;
  const remembered = state.selection;
  if (!connected && !remembered) {
    print("No context is connected to this session.");
    return;
  }

  const result = await disconnectSelection(state.client);
  if (!result.ok) {
    print("Could not disconnect the context. Try again.");
    return;
  }

  const name = connected?.name ?? remembered.contextName;
  print(`Disconnected the "${name}" context from this session.`);
}

// A context with no routing description can only be routed to by name, which is
// what makes a standard context — whose profile the plugin cannot read until it
// is connected — much worse at routing than a lite one. Connecting is the
// moment that changes: the document is readable now, and the session that ran
// this command has a model to summarize it with. So the fix is to say so, here,
// and let the session do it.
async function nudgeForDescription(target) {
  const routing = await readRouting();
  if ((routing.cards[target.id]?.useWhen || target.routingDescription || "").length > 0) {
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

async function commandMode(query, flags) {
  const routing = await readRouting();
  const id = sessionId();
  if (query.length === 0) {
    const active = resolveMode(routing, id);
    const scope = MODES.includes(routing.sessions[id]?.mode) ? "this session" : "the default";
    print(`Context routing is ${active} (${scope}).`);
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
  const isGlobal = flags.global === true || flags.global === "true";
  const result = await setMode(wanted, { global: isGlobal, id });
  print(
    result.scope === "global"
      ? `Context routing is now ${wanted} everywhere (the default for new sessions).`
      : `Context routing is now ${wanted} for this session.`
  );
  if (wanted === "auto") {
    print(
      "In auto mode this session switches context on its own, and tells you when it does. " +
        "Other Claude Code windows keep theirs."
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

// The model in the active Claude Code session writes the capture spec: it is
// the only process that can see the conversation, and reusing it avoids a
// second model call or a transcript reader. This command validates that output,
// turns it into files, and creates or updates the selected lite context.
function printChangedFiles(label, files) {
  if (files.length === 0) {
    return;
  }
  print(`  ${label}: ${files.join(", ")}`);
}

function printUpdatePreview(preview) {
  const { record, changes } = preview;
  print(`Update the "${record.name}" lite context?`);
  print(`  Domain profile: ${preview.profileChanged ? "changed" : "unchanged"}`);
  print(`  Routing description: ${preview.routingChanged ? "changed" : "unchanged"}`);
  print(
    `  Knowledge files: ${changes.added.length} added, ` +
      `${changes.updated.length} updated, ${changes.removed.length} removed`
  );
  printChangedFiles("Add", changes.added);
  printChangedFiles("Update", changes.updated);
  printChangedFiles("Remove", changes.removed);
  if (!record.knowledgeManaged) {
    print(`  Linked knowledge folder will not be modified: ${record.knowledgeFolder}`);
  }
  print("Re-run this save with --yes to confirm.");
}

async function commandSave(flags) {
  const source = typeof flags.from === "string" ? flags.from : "";
  if (source.trim().length === 0) {
    print("Pass the generated conversation capture with --from <capture.json>.");
    return;
  }

  let capture;
  try {
    capture = JSON.parse(await readFile(source, "utf8"));
  } catch {
    print(`Could not read a valid conversation capture JSON file at ${source}.`);
    return;
  }
  if (capture?.schema !== 1) {
    print("Unsupported conversation capture schema. Expected schema 1.");
    return;
  }

  try {
    if (typeof capture.targetId === "string" && capture.targetId.length > 0) {
      const preview = await previewCapturedLiteUpdate(capture);
      if (!preview.changed) {
        print(`The capture does not change the "${preview.record.name}" context.`);
        return;
      }
      if (flags.yes !== true && flags.yes !== "true") {
        printUpdatePreview(preview);
        return;
      }
      const result = await updateCapturedLite(capture);
      await putCard(result.record.id, {
        useWhen: result.routingDescription,
        source: result.profileText
      }).catch(() => undefined);
      if (flags.consume === true || flags.consume === "true") {
        await rm(source, { force: true });
      }
      // The save nudge's "nothing new since the last save" suppressor starts
      // counting from here.
      await noteSaved(sessionId()).catch(() => undefined);
      print(`Updated context: ${result.record.name}`);
      print(`Lite context folder: ${result.record.directory}`);
      print(`Profile path: ${result.record.profilePath}`);
      print(`Knowledge folder: ${result.record.knowledgeFolder}`);
      if (!result.record.knowledgeManaged) {
        print(`Conversation knowledge folder: ${result.record.conversationKnowledgeFolder}`);
      }
      print(`Use command: /neatcontext:use ${result.record.name}`);
      return;
    }

    const result = await createCapturedLite({
      ...capture,
      capturedFrom: "claude-code-conversation"
    });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    if (flags.consume === true || flags.consume === "true") {
      await rm(source, { force: true });
    }
    await noteSaved(sessionId()).catch(() => undefined);
    print(`Lite context folder: ${result.record.directory}`);
    print(`Profile path: ${result.record.profilePath}`);
    print(`Knowledge folder: ${result.record.knowledgeFolder}`);
    print(`Use command: /neatcontext:use ${result.record.name}`);
  } catch (error) {
    if (error instanceof LiteContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

async function commandImport(flags) {
  const source = typeof flags.from === "string" ? flags.from : "";
  const name = typeof flags.name === "string" ? flags.name : "";
  try {
    const result = await importCapturedLite({ bundleFolder: source, name });
    await putCard(result.record.id, {
      useWhen: result.routingDescription,
      source: result.profileText
    }).catch(() => undefined);
    print(`Imported the "${result.record.name}" conversation context.`);
    print(`  Domain profile:   ${result.record.profilePath}`);
    print(
      `  Knowledge folder: ${result.record.knowledgeFolder} ` +
        `(${result.knowledgeFileCount} files)`
    );
    print(`  Local bundle:     ${result.record.directory}`);
    print(`  Connect it with:  /neatcontext:use ${result.record.name}`);
    print(`The shared source folder (${source}) was left untouched.`);
  } catch (error) {
    if (error instanceof LiteContextError) {
      print(error.message);
      return;
    }
    throw error;
  }
}

// Export resolves like `delete` — over lite contexts only, since a standard
// context's files belong to the desktop app. The routing description is read
// from the card rather than the manifest: `describe` records a newer line there,
// and the copy the teammate imports should route the way this one does.
async function commandExport(state, query, flags) {
  const destination = typeof flags.to === "string" ? flags.to : "";
  if (destination.trim().length === 0) {
    print("Pass the destination folder with --to <folder>.");
    return;
  }

  let target = null;
  if (query.length === 0) {
    if (state.connected?.kind === "lite" && state.connected.record) {
      target = state.connected.record;
    } else {
      print("Which lite context should I export?");
      print("");
      print(formatLiteList(state));
      return;
    }
  } else {
    const resolution = resolveContext(state.lite, query);
    if (resolution.error) {
      const standardMatch = state.contexts.find(
        (context) =>
          context.kind === "standard" &&
          context.name.toLowerCase().includes(query.toLowerCase())
      );
      if (standardMatch) {
        print(
          `"${standardMatch.name}" is a standard context. Only lite contexts can be exported ` +
            "from here — standard ones are managed in the NeatContext desktop app."
        );
        return;
      }
      print(`No single lite context matched "${query}".`);
      print("");
      print(formatLiteList(state));
      return;
    }
    target = resolution.context;
  }

  const routing = await readRouting();
  try {
    const result = await exportLite({
      record: target,
      destination,
      force: flags.force === true || flags.force === "true",
      routingDescription: routing.cards[target.id]?.useWhen
    });
    print(
      result.replaced
        ? `Exported the "${result.record.name}" context, replacing what was there.`
        : `Exported the "${result.record.name}" context.`
    );
    print(`  Bundle folder:    ${result.destination}`);
    print(`  Knowledge files:  ${result.knowledgeFileCount}`);
    print(`  Import it with:   /neatcontext:import ${result.destination}`);
    print("This context was not changed — the export is a copy.");
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
    print(
      target.knowledgeManaged
        ? `Its generated knowledge folder (${target.knowledgeFolder}) is inside the bundle and will be deleted.`
        : `Its knowledge folder (${target.knowledgeFolder}) will NOT be touched.`
    );
    print("Re-run with --yes to confirm.");
    return;
  }

  const deleted = await deleteLite(target.id);
  if (!deleted) {
    print(`The "${target.name}" lite context was already gone.`);
    return;
  }
  print(`Deleted the "${deleted.name}" lite context.`);
  print(
    deleted.knowledgeManaged
      ? `Its generated knowledge folder (${deleted.knowledgeFolder}) was deleted with it.`
      : `Its knowledge folder (${deleted.knowledgeFolder}) was left untouched.`
  );
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
  if (command === "save") {
    await commandSave(flags);
    return;
  }
  if (command === "import") {
    await commandImport(flags);
    return;
  }
  // Reads no context list and touches no connection: the one command that still
  // answers with the desktop app closed and nothing created yet.
  if (command === "mode") {
    await commandMode(query, flags);
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
  if (command === "save-target") {
    await commandSaveTarget(state, query);
    return;
  }
  if (command === "use") {
    await commandUse(state, query);
    return;
  }
  if (command === "disconnect") {
    await commandDisconnect(state);
    return;
  }
  if (command === "export") {
    await commandExport(state, query, flags);
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
      "Use: status | list | use | disconnect | create | save | import | export | delete | mode | alias | describe."
  );
}

run()
  .catch((error) => {
    print(`NeatContext plugin error: ${error?.message ?? error}`);
  })
  .finally(() => process.exit(0));
