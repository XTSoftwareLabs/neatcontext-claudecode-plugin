// The `extensions` command, written once for every host.
//
// Configuring an extension is hand work: the user writes a binding into
// `<home>/extensions.json` themselves, because that file is where this
// machine's authority lives and nothing should be able to write it on their
// behalf. What the command does is make that work possible to finish — say what
// the connected context is asking for, whether this machine answers it, and if
// not, exactly what is missing.
//
// Each host wraps this with its own command syntax and its own printer. The
// wording of a status line is not host-specific and should not drift between
// them.

import {
  addExtensionDeclaration,
  declarationProblem,
  removalProblem,
  removeExtensionDeclaration
} from "./extensions.mjs";
import { bindingsFilePath, readBindings } from "./extension-bindings.mjs";
import { createExtensionHost } from "./extension-runtime.mjs";
import { setContextExtensions } from "./context-store.mjs";

export { bindingsFilePath };

const LABELS = {
  ready: "ready",
  unconfigured: "not configured on this machine",
  unavailable: "unavailable",
  failed: "failed"
};

function exampleBinding(id) {
  return [
    "  {",
    '    "schema": 1,',
    '    "extensions": {',
    `      "${id}": {`,
    '        "command": "node",',
    '        "args": ["C:/path/to/that-extensions-mcp-server.js"],',
    '        "envFrom": ["THE_API_TOKEN"]',
    "      }",
    "    }",
    "  }"
  ].join("\n");
}

// Everything `extensions` prints when it is asked for the current picture.
export async function renderExtensionsStatus(record, { createHost = createExtensionHost } = {}) {
  const lines = [];
  if (!record) {
    return [
      "No context is connected to this session, so there is nothing to configure yet.",
      "Connect one first — extensions belong to a context, not to the machine."
    ].join("\n");
  }

  lines.push(`Extensions for the "${record.name}" context:`);
  if (record.extensions.length === 0) {
    lines.push("");
    lines.push("  (none declared)");
    lines.push("");
    lines.push(
      "A context declares what it expects to reach; this machine says what provides it. " +
        "Declare one with `extensions add <id> --capability \"what it lets this context do\"`."
    );
    return lines.join("\n");
  }

  const { problems } = await readBindings();
  const host = createHost();
  let statuses;
  try {
    ({ statuses } = await host.resolve(record));
  } finally {
    host.dispose();
  }

  for (const status of statuses) {
    lines.push("");
    lines.push(
      `  ${status.id} — ${LABELS[status.status]}${status.importance === "important" ? " (important to this context)" : ""}`
    );
    lines.push(`    Capability: ${status.capability}`);
    if (status.tools.length > 0) {
      lines.push(`    Tools:      ${status.tools.join(", ")}`);
    }
    if (status.detail) {
      lines.push(`    ${status.detail}`);
    }
    if (status.status === "unconfigured") {
      lines.push(`    Bindings file: ${bindingsFilePath()}`);
    }
  }

  if (problems.length > 0) {
    lines.push("");
    lines.push(`Problems in ${bindingsFilePath()}:`);
    for (const problem of problems) {
      lines.push(`  ${problem.message}`);
    }
  }

  const unconfigured = statuses.filter((status) => status.status === "unconfigured");
  if (unconfigured.length > 0) {
    lines.push("");
    lines.push(`To connect ${unconfigured[0].id} on this machine, add it to ${bindingsFilePath()}:`);
    lines.push("");
    lines.push(exampleBinding(unconfigured[0].id));
    lines.push("");
    lines.push(
      "Put credentials in the environment and name them in `envFrom` rather than writing " +
        "them into the file. Nothing in there travels with the context."
    );
  }

  const missing = statuses.filter((status) => status.status !== "ready");
  if (missing.length > 0) {
    lines.push("");
    lines.push(
      "The context works either way: its profile and knowledge folder are served whether or " +
        "not any of this is configured."
    );
  }
  return lines.join("\n");
}

// Validation failures are the expected outcome of a hand-typed id or capability,
// so they come back as text to relay rather than as an exception each host has
// to remember to catch. Anything else — a bundle that vanished mid-command, a
// disk that will not take the write — is not this function's to interpret and
// travels on.
export async function addExtensionToContext(record, id, { capability, tools, important }) {
  const declaration = {
    id,
    capability,
    importance: important ? "important" : "optional",
    tools:
      typeof tools === "string" && tools.trim().length > 0
        ? tools.split(",").map((entry) => entry.trim()).filter(Boolean)
        : undefined
  };
  const problem = declarationProblem(record.extensions, declaration);
  if (problem) return { record, text: problem };
  const updated = await setContextExtensions(
    record,
    addExtensionDeclaration(record.extensions, declaration)
  );
  const added = updated.extensions.find((entry) => entry.id === declaration.id);
  return {
    record: updated,
    text: [
      `The "${updated.name}" context now expects the "${added.id}" extension.`,
      `  Capability: ${added.capability}`,
      added.tools ? `  Tools:      ${added.tools.join(", ")}` : "  Tools:      (whatever it offers)",
      "",
      "That is a declaration, not a connection: nothing runs until this machine binds it in",
      `${bindingsFilePath()}. The declaration travels with the context; the binding does not.`
    ].join("\n")
  };
}

export async function removeExtensionFromContext(record, id) {
  const problem = removalProblem(record.extensions, id);
  if (problem) return { record, text: problem };
  const updated = await setContextExtensions(
    record,
    removeExtensionDeclaration(record.extensions, id)
  );
  return {
    record: updated,
    text:
      `The "${updated.name}" context no longer expects "${id}". Your local binding for it, if ` +
      "there is one, was not touched."
  };
}

// Starting one extension on purpose, to find out whether the binding works.
// Deliberately separate from status: this one names what it found, so a user
// comparing a binding against a server's real tool list has something to read.
export async function testExtension(record, id, { createHost = createExtensionHost } = {}) {
  const declaration = record.extensions.find((entry) => entry.id === id);
  if (!declaration) {
    return (
      `The "${record.name}" context does not declare an extension "${id}". ` +
      `It declares: ${record.extensions.map((entry) => entry.id).join(", ") || "(none)"}.`
    );
  }
  const host = createHost();
  try {
    const { statuses } = await host.resolve({ ...record, extensions: [declaration] });
    const status = statuses[0];
    const lines = [`${id}: ${LABELS[status.status]}`];
    if (status.status === "ready") {
      lines.push(`  Tools this context can call: ${status.tools.join(", ")}`);
      if (status.detail) lines.push(`  ${status.detail}`);
    } else {
      lines.push(`  ${status.detail ?? "No further detail."}`);
      if (status.status === "unconfigured") {
        lines.push("");
        lines.push(`Add it to ${bindingsFilePath()}:`);
        lines.push("");
        lines.push(exampleBinding(id));
      }
    }
    return lines.join("\n");
  } finally {
    host.dispose();
  }
}
