// How this machine provides what a context asked for.
//
// A context declares an extension by id and says what capability it wants. This
// file is the other half: the local, hand-written answer to "and what actually
// runs it here". It lives outside every context, at
// `<home>/extensions.json`, and nothing that reads or writes a context
// ever touches it.
//
// That separation is what makes a shared context safe to accept. The command,
// its arguments, its working directory and its environment are stated here, by
// the person sitting at this machine, or they are not stated at all — in which
// case the declared extension is simply reported as unconfigured and the context
// carries on serving its profile and knowledge without it.
//
// Environment handling is deliberately narrow. A spawned extension server gets a
// small base environment plus exactly what the binding names: literal values in
// `env`, and pass-throughs in `envFrom` naming variables already set in the
// user's own shell. `envFrom` is the one to reach for with a credential, because
// it lets the secret stay in the environment — or a secret manager feeding it —
// instead of being copied into a file on disk.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isValidExtensionId } from "./extensions.mjs";
import { neatContextHome } from "./storage-home.mjs";

export const BINDINGS_SCHEMA = 1;
const MAX_ARGS = 64;
const MAX_ENV_ENTRIES = 64;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// What a spawned extension server gets before the binding adds anything. Enough
// for a Node, Python, or Go server to find its interpreter and a temp directory,
// and nothing that happens to be sitting in the user's shell beyond that.
const BASE_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS"
];

export class ExtensionBindingError extends Error {}

export function bindingsFilePath() {
  return path.join(neatContextHome(), "extensions.json");
}

// Windows environment variable names are case-insensitive, and a binding that
// says `path` should not silently fail to find `Path`.
function lookupEnv(source, name) {
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return source[key];
  }
  return undefined;
}

function normalizeArgs(value, id) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ExtensionBindingError(`The "args" for extension "${id}" must be an array.`);
  }
  if (value.length > MAX_ARGS) {
    throw new ExtensionBindingError(`Extension "${id}" passes more than ${MAX_ARGS} arguments.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new ExtensionBindingError(
        `Every argument for extension "${id}" must be a string.`
      );
    }
    return entry;
  });
}

function normalizeEnv(value, id) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionBindingError(
      `The "env" for extension "${id}" must be an object of name/value pairs.`
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new ExtensionBindingError(
      `Extension "${id}" sets more than ${MAX_ENV_ENTRIES} environment variables.`
    );
  }
  const env = {};
  for (const [name, entry] of entries) {
    if (!ENV_NAME.test(name)) {
      throw new ExtensionBindingError(
        `"${name}" is not a usable environment variable name for extension "${id}".`
      );
    }
    if (typeof entry !== "string") {
      // Deliberately does not name the value: this message can reach a log.
      throw new ExtensionBindingError(
        `The value of ${name} for extension "${id}" must be a string.`
      );
    }
    env[name] = entry;
  }
  return env;
}

function normalizeEnvFrom(value, id) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ExtensionBindingError(
      `The "envFrom" for extension "${id}" must be an array of variable names.`
    );
  }
  const names = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!ENV_NAME.test(name)) {
      throw new ExtensionBindingError(
        `"${name || "(empty)"}" is not a usable environment variable name for extension "${id}".`
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function normalizeAllowedContexts(value, id) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ExtensionBindingError(
      `The "allowedContexts" for extension "${id}" must be an array of context names or ids.`
    );
  }
  const allowed = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return allowed.length > 0 ? allowed : null;
}

export function normalizeBinding(id, value) {
  if (!isValidExtensionId(id)) {
    throw new ExtensionBindingError(`"${id}" is not a usable extension id.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionBindingError(`The binding for extension "${id}" must be an object.`);
  }
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (command.length === 0) {
    throw new ExtensionBindingError(
      `Extension "${id}" needs a "command" naming the program that serves it.`
    );
  }
  const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd.trim() : null;
  return {
    id,
    command,
    args: normalizeArgs(value.args, id),
    cwd,
    env: normalizeEnv(value.env, id),
    envFrom: normalizeEnvFrom(value.envFrom, id),
    enabled: value.enabled !== false,
    allowedContexts: normalizeAllowedContexts(value.allowedContexts, id)
  };
}

// One unusable binding must not take the rest of the file with it: the other
// extensions on this machine still work, and the broken one is reported as
// unconfigured with the reason attached.
export function readBindingsFrom(parsed) {
  const bindings = new Map();
  const problems = [];
  const source = parsed?.extensions;
  if (source === undefined || source === null) return { bindings, problems };
  if (typeof source !== "object" || Array.isArray(source)) {
    problems.push({ id: null, message: 'The "extensions" field must be an object keyed by extension id.' });
    return { bindings, problems };
  }
  for (const [id, value] of Object.entries(source)) {
    try {
      const binding = normalizeBinding(id.trim().toLowerCase(), value);
      bindings.set(binding.id, binding);
    } catch (error) {
      problems.push({ id, message: error.message });
    }
  }
  return { bindings, problems };
}

export async function readBindings() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(bindingsFilePath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { bindings: new Map(), problems: [], exists: false };
    return {
      bindings: new Map(),
      problems: [{ id: null, message: `${bindingsFilePath()} is not valid JSON.` }],
      exists: true
    };
  }
  return { ...readBindingsFrom(parsed), exists: true };
}

// Written 0600 because this is the file a binding's literal `env` values land
// in. Atomic, so a half-written bindings file never leaves every extension on
// the machine unconfigured.
export async function writeBindings(bindings) {
  const file = bindingsFilePath();
  const temporary = path.join(
    path.dirname(file),
    `.extensions-${randomBytes(6).toString("hex")}.json`
  );
  const extensions = {};
  for (const [id, binding] of [...bindings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = { command: binding.command };
    if (binding.args.length > 0) entry.args = binding.args;
    if (binding.cwd) entry.cwd = binding.cwd;
    if (Object.keys(binding.env).length > 0) entry.env = binding.env;
    if (binding.envFrom.length > 0) entry.envFrom = binding.envFrom;
    if (!binding.enabled) entry.enabled = false;
    if (binding.allowedContexts) entry.allowedContexts = binding.allowedContexts;
    extensions[id] = entry;
  }
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schema: BINDINGS_SCHEMA, extensions }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// The environment a spawned extension server actually receives.
export function resolveEnvironment(binding, source = process.env) {
  const env = {};
  for (const name of BASE_ENV_NAMES) {
    const value = lookupEnv(source, name);
    if (typeof value === "string") env[name] = value;
  }
  const missing = [];
  for (const name of binding.envFrom) {
    const value = lookupEnv(source, name);
    if (typeof value === "string" && value.length > 0) env[name] = value;
    else missing.push(name);
  }
  // Literals win, so a binding can override a pass-through it also named.
  for (const [name, value] of Object.entries(binding.env)) {
    env[name] = value;
  }
  return { env, missing };
}

function contextMatches(allowed, record) {
  const wanted = allowed.map((entry) => entry.toLowerCase());
  return wanted.includes(record.name.toLowerCase()) || wanted.includes(record.id.toLowerCase());
}

// Everything that can be decided without starting anything. Returns either a
// spec ready to spawn, or the reason this declaration will not be served here.
export function resolveBinding(declaration, bindings, record) {
  const binding = bindings.get(declaration.id);
  if (!binding) {
    return {
      status: "unconfigured",
      detail:
        `No local binding for "${declaration.id}". Add one to ${bindingsFilePath()} to ` +
        "connect it on this machine."
    };
  }
  if (!binding.enabled) {
    return {
      status: "unconfigured",
      detail: `"${declaration.id}" is turned off in your local extension configuration.`
    };
  }
  if (binding.allowedContexts && !contextMatches(binding.allowedContexts, record)) {
    return {
      status: "unconfigured",
      detail:
        `Your local binding for "${declaration.id}" does not list "${record.name}" in ` +
        "allowedContexts, so this context may not use it."
    };
  }
  const { env, missing } = resolveEnvironment(binding);
  if (missing.length > 0) {
    return {
      status: "unconfigured",
      detail:
        `"${declaration.id}" expects ${missing.join(", ")} in the environment, and ` +
        `${missing.length === 1 ? "it is" : "they are"} not set. Export ` +
        `${missing.length === 1 ? "it" : "them"} where this host starts, then reconnect.`
    };
  }
  return {
    status: "bound",
    spec: { command: binding.command, args: binding.args, cwd: binding.cwd, env }
  };
}
