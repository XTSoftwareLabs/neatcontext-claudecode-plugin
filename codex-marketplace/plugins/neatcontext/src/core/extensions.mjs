// What a Context says it needs from the outside world.
//
// A context is a domain profile plus local knowledge. Some domains also need to
// reach a system: the incident tracker, the log store, the internal service that
// knows what a customer is actually on. An extension declaration is how a
// context says which of those it expects, without saying anything about how this
// machine provides it.
//
// The split is the whole point, and it runs in one direction:
//
//   declaration  travels with the context   what capability it expects
//   binding      never leaves this machine  which program provides it, and how
//
// So the normalizer below is a whitelist, not a validator that merely rejects
// bad input, and it is a whitelist by construction rather than by filtering:
// `normalizeExtensionDeclaration` and `serializeExtensionDeclarations` never
// copy the object handed to them. Each builds a fresh entry out of the four
// fields it names — id, capability, importance, tools — so anything else an
// input carries is gone on the way in and on the way out, without anyone having
// to remember to strip it. A context handed to you by someone else therefore
// cannot carry a command to run, a path to execute, an environment to inject,
// or a token to spend, not even if its author wrote one into context.json by
// hand. Importing a context can never, by itself, make anything runnable.

export const MAX_EXTENSIONS = 8;
export const MAX_DECLARED_TOOLS = 64;
const MAX_CAPABILITY_LENGTH = 200;

// No dots: a declared id becomes half of a tool name (`<id>__<tool>`), and the
// hosts that receive that name accept only letters, digits, `_` and `-`.
const EXTENSION_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ExtensionDeclarationError extends Error {}

export function isValidExtensionId(value) {
  return typeof value === "string" && EXTENSION_ID.test(value);
}

// The name a declared tool is advertised under. Namespaced by extension id
// because two extensions may both call something `search`, and the session has
// to be able to tell them apart from the name alone.
export function qualifiedToolName(extensionId, toolName) {
  return `${extensionId}__${toolName}`;
}

export function parseQualifiedToolName(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("__");
  if (separator <= 0) return null;
  const extensionId = value.slice(0, separator);
  const toolName = value.slice(separator + 2);
  if (!EXTENSION_ID.test(extensionId) || !TOOL_NAME.test(toolName)) return null;
  return { extensionId, toolName };
}

function normalizeCapability(value, id) {
  const capability = (value ?? "").trim().replace(/\s+/g, " ");
  if (capability.length === 0) {
    throw new ExtensionDeclarationError(
      `Extension "${id}" needs a capability line saying what it lets this context do.`
    );
  }
  if (capability.length > MAX_CAPABILITY_LENGTH) {
    throw new ExtensionDeclarationError(
      `Keep the capability line for "${id}" under ${MAX_CAPABILITY_LENGTH} characters.`
    );
  }
  return capability;
}

function normalizeDeclaredTools(value, id) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ExtensionDeclarationError(
      `The "tools" list for extension "${id}" must be an array of tool names.`
    );
  }
  // An empty array is not "no tools" — it is a context that named none, which
  // means the same thing as omitting the field: use whatever the extension has.
  if (value.length === 0) return null;
  if (value.length > MAX_DECLARED_TOOLS) {
    throw new ExtensionDeclarationError(
      `Extension "${id}" declares more than ${MAX_DECLARED_TOOLS} tools.`
    );
  }
  const tools = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!TOOL_NAME.test(name)) {
      throw new ExtensionDeclarationError(
        `"${name || "(empty)"}" is not a usable tool name for extension "${id}".`
      );
    }
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

// One declaration, reduced to the four things that are safe to carry.
export function normalizeExtensionDeclaration(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ExtensionDeclarationError("Each extension declaration must be an object.");
  }
  const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
  if (!EXTENSION_ID.test(id)) {
    throw new ExtensionDeclarationError(
      `"${entry.id ?? "(missing)"}" is not a usable extension id. Use lowercase letters, ` +
        "digits, hyphens, or underscores."
    );
  }
  const importance = entry.importance === "important" ? "important" : "optional";
  const declaration = {
    id,
    capability: normalizeCapability(entry.capability, id),
    importance
  };
  const tools = normalizeDeclaredTools(entry.tools, id);
  if (tools) declaration.tools = tools;
  return declaration;
}

// Reads whatever is on a manifest and returns only declarations. Used on both
// sides of the boundary: when a context is read from disk, and when one is
// written back out. A manifest with no extensions produces an empty array, so
// callers never branch on the field being absent.
export function normalizeExtensionDeclarations(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ExtensionDeclarationError(
      "The \"extensions\" field must be an array of extension declarations."
    );
  }
  if (value.length > MAX_EXTENSIONS) {
    throw new ExtensionDeclarationError(
      `A context may declare at most ${MAX_EXTENSIONS} extensions.`
    );
  }
  const declarations = [];
  const seen = new Set();
  for (const entry of value) {
    const declaration = normalizeExtensionDeclaration(entry);
    if (seen.has(declaration.id)) {
      throw new ExtensionDeclarationError(
        `Extension "${declaration.id}" is declared more than once.`
      );
    }
    seen.add(declaration.id);
    declarations.push(declaration);
  }
  return declarations;
}

// The lenient read used when loading a context that may have been hand-edited or
// written by a newer plugin. A malformed declaration must not take the whole
// context down with it: the profile and the knowledge folder are what the
// session actually needs, and they are still fine. Bad entries are dropped.
export function readExtensionDeclarations(value) {
  if (!Array.isArray(value)) return [];
  const declarations = [];
  const seen = new Set();
  for (const entry of value.slice(0, MAX_EXTENSIONS)) {
    let declaration;
    try {
      declaration = normalizeExtensionDeclaration(entry);
    } catch {
      continue;
    }
    if (seen.has(declaration.id)) continue;
    seen.add(declaration.id);
    declarations.push(declaration);
  }
  return declarations;
}

// What goes back into context.json. Returns undefined for an empty list so a
// context with no extensions keeps a manifest with no extensions field, rather
// than growing an empty array the first time it is saved.
export function serializeExtensionDeclarations(declarations) {
  const normalized = normalizeExtensionDeclarations(declarations);
  if (normalized.length === 0) return undefined;
  return normalized.map((declaration) => {
    const entry = {
      id: declaration.id,
      capability: declaration.capability,
      importance: declaration.importance
    };
    if (declaration.tools) entry.tools = declaration.tools;
    return entry;
  });
}

// Authoring, kept here so every host edits declarations the same way.
export function addExtensionDeclaration(declarations, entry) {
  const declaration = normalizeExtensionDeclaration(entry);
  const existing = normalizeExtensionDeclarations(declarations);
  const index = existing.findIndex((current) => current.id === declaration.id);
  if (index === -1 && existing.length >= MAX_EXTENSIONS) {
    throw new ExtensionDeclarationError(
      `This context already declares ${MAX_EXTENSIONS} extensions. Remove one first.`
    );
  }
  if (index === -1) return [...existing, declaration];
  const replaced = [...existing];
  replaced[index] = declaration;
  return replaced;
}

export function removeExtensionDeclaration(declarations, id) {
  const target = typeof id === "string" ? id.trim().toLowerCase() : "";
  const existing = normalizeExtensionDeclarations(declarations);
  const remaining = existing.filter((declaration) => declaration.id !== target);
  if (remaining.length === existing.length) {
    throw new ExtensionDeclarationError(`This context does not declare an extension "${target}".`);
  }
  return remaining;
}

// Why this edit cannot be made, or null if it can.
//
// A hand-typed id or a capability line someone left blank is ordinary input for
// the `extensions` command, not a defect, so the command layer asks first rather
// than catching. Anything these throw that is not about the declaration itself
// is a real fault and is left to travel.
export function declarationProblem(declarations, entry) {
  try {
    addExtensionDeclaration(declarations, entry);
    return null;
  } catch (error) {
    if (error instanceof ExtensionDeclarationError) return error.message;
    throw error;
  }
}

export function removalProblem(declarations, id) {
  try {
    removeExtensionDeclaration(declarations, id);
    return null;
  } catch (error) {
    if (error instanceof ExtensionDeclarationError) return error.message;
    throw error;
  }
}

// Which of an extension's tools this context actually wants. A declaration that
// names none takes whatever the extension offers; one that names some takes only
// those, and names the rest as unmatched so the user can see a stale declaration
// rather than silently getting fewer tools than they asked for.
export function selectDeclaredTools(declaration, offered) {
  const available = Array.isArray(offered) ? offered : [];
  if (!declaration.tools) {
    return { selected: available, missing: [] };
  }
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  const selected = [];
  const missing = [];
  for (const name of declaration.tools) {
    const tool = byName.get(name);
    if (tool) selected.push(tool);
    else missing.push(name);
  }
  return { selected, missing };
}
