// E2E: every command and skill each plugin ships can still be loaded by its host.
//
// Hosts read this frontmatter with a real YAML parser and then type-check the
// fields. A value that parses as the wrong YAML type is not cosmetic — the host
// rejects the whole command. `argument-hint: [context name or number]` is the
// live example: those brackets are a YAML flow sequence, not a string, so
// Copilot refused /neatcontext:delete, :import, :mode, :save and :use with
// "argument-hint must be a string". /neatcontext:export survived only because
// its hint happened to be quoted already.
//
// Scope, stated honestly: nothing here launches a host, so this cannot prove a
// host accepts a command. What it does prove is the part that broke — every
// shipped command and skill parses as flat YAML, carries the fields its host
// needs, and gives every field the type the host demands. That check is what
// was missing, and it covers all five plugins at once rather than the one host
// somebody happened to try.
//
//   node tools/e2e-commands.mjs

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every plugin in the repo, and the surface its host loads commands from.
// Claude Code and Copilot expose slash commands directly; Kimi Code ships both
// commands and the skills they delegate to; Codex and pi are skills-only.
export const PLUGINS = [
  { name: "Claude Code", root: ["plugins", "claude-code", "neatcontext"] },
  { name: "GitHub Copilot", root: ["plugins", "copilot", "neatcontext"] },
  { name: "Kimi Code", root: ["plugins", "kimi-code", "neatcontext"] },
  { name: "Codex", root: ["codex-marketplace", "plugins", "neatcontext"] },
  { name: "pi", root: ["plugins", "pi", "neatcontext"] }
].map((plugin) => ({ ...plugin, dir: path.join(repositoryRoot, ...plugin.root) }));

// Fields a host reads as text. `argument-hint` is the one that regressed, but
// every field here fails the same way when YAML hands the host a sequence.
const STRING_FIELDS = ["name", "description", "argument-hint", "allowed-tools"];
const BOOLEAN_FIELDS = ["disable-model-invocation", "disableModelInvocation"];
// A typo'd key is silently dropped rather than rejected, which is worse than a
// hard failure: the command loads with its hint or its guard quietly missing.
const KNOWN_FIELDS = new Set([...STRING_FIELDS, ...BOOLEAN_FIELDS, "model"]);

/**
 * Classify a raw frontmatter value the way a YAML parser would, far enough to
 * tell a string from the things that are not one.
 */
export function classifyValue(raw) {
  if (raw === undefined || raw === "") return { kind: "empty" };

  const first = raw[0];
  if (first === '"' || first === "'") {
    if (raw.length >= 2 && raw.at(-1) === first) return { kind: "string", value: raw.slice(1, -1) };
    return { kind: "invalid", reason: `unterminated ${first === '"' ? "double" : "single"}-quoted value` };
  }
  if (first === "[") {
    return { kind: "sequence", reason: "square brackets are a YAML flow sequence, not a string — quote the value" };
  }
  if (first === "{") {
    return { kind: "mapping", reason: "braces are a YAML flow mapping, not a string — quote the value" };
  }
  if (first === "|" || first === ">") {
    return { kind: "block", reason: `"${first}" starts a block scalar, which needs indented continuation lines` };
  }
  if ("&*!%@`".includes(first)) {
    return { kind: "invalid", reason: `a plain value may not start with "${first}"` };
  }
  // "-", "?" and ":" only act as indicators when a space follows them.
  if ((first === "-" || first === "?" || first === ":") && (raw.length === 1 || raw[1] === " ")) {
    return { kind: "invalid", reason: `a plain value may not start with "${first} "` };
  }
  if (/^(?:true|false)$/i.test(raw)) return { kind: "boolean", value: /^true$/i.test(raw) };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return { kind: "number", value: Number(raw) };
  if (raw === "null" || raw === "~") return { kind: "empty" };
  if (raw.includes(": ")) {
    return { kind: "invalid", reason: 'an unquoted ": " makes YAML read the rest as a nested key' };
  }
  if (raw.endsWith(":")) {
    return { kind: "invalid", reason: 'an unquoted trailing ":" makes YAML read the value as a key' };
  }
  if (/\s#/.test(raw)) {
    return { kind: "invalid", reason: 'an unquoted " #" starts a YAML comment and truncates the value' };
  }
  return { kind: "string", value: raw };
}

/**
 * Read the frontmatter block as a flat key/value map, reporting anything a host
 * would choke on rather than guessing past it.
 */
export function readFrontmatter(markdown) {
  const text = markdown.replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const problems = [];

  // A fence problem is fatal: there is no frontmatter to type-check, and
  // reporting every field as missing on top of it only buries the real cause.
  if (!text.startsWith("---\n")) {
    return { fields: {}, body: "", fatal: true, problems: ["does not open with a --- frontmatter fence"] };
  }
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) {
    return { fields: {}, body: "", fatal: true, problems: ["never closes its --- frontmatter fence"] };
  }

  const fields = {};
  const lines = text.slice(4, end + 1).split("\n").slice(0, -1);
  lines.forEach((line, index) => {
    const number = index + 2; // the opening fence is line 1
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    if (/^\s/.test(line)) {
      problems.push(`line ${number}: indented frontmatter — these files must be flat "key: value" pairs`);
      return;
    }
    const match = /^([A-Za-z0-9_.-]+):(?:\s(.*))?$/.exec(line);
    if (!match) {
      problems.push(`line ${number}: not a flat "key: value" pair — ${JSON.stringify(line)}`);
      return;
    }
    const [, key, rest] = match;
    if (key in fields) {
      problems.push(`line ${number}: duplicate key "${key}"`);
      return;
    }
    fields[key] = { line: number, raw: (rest ?? "").trim(), ...classifyValue((rest ?? "").trim()) };
  });

  return { fields, body: text.slice(end + 5), problems };
}

/**
 * Apply the host contract to one command or skill file. Returns the problems
 * that would keep a host from loading it, empty when it is fine.
 */
export function checkCommandFile(markdown, { kind }) {
  const { fields, body, problems, fatal } = readFrontmatter(markdown);
  if (fatal) return [...problems];
  const found = [...problems];

  const required = kind === "skill" ? ["name", "description"] : ["description"];
  for (const key of required) {
    if (!(key in fields)) found.push(`missing required "${key}"`);
  }

  for (const [key, field] of Object.entries(fields)) {
    if (!KNOWN_FIELDS.has(key)) {
      found.push(`line ${field.line}: unknown field "${key}" — a host drops it silently`);
      continue;
    }
    if (STRING_FIELDS.includes(key) && field.kind !== "string") {
      found.push(
        `line ${field.line}: "${key}" must be a string, but YAML reads ${JSON.stringify(field.raw)} as ` +
          `${field.kind}${field.reason ? ` (${field.reason})` : ""}`
      );
    }
    if (BOOLEAN_FIELDS.includes(key) && field.kind !== "boolean") {
      found.push(
        `line ${field.line}: "${key}" must be a boolean, but YAML reads ${JSON.stringify(field.raw)} as ${field.kind}`
      );
    }
    if (key === "description" && field.kind === "string" && field.value.trim() === "") {
      found.push(`line ${field.line}: "description" is empty`);
    }
  }

  // A command whose body is empty parses fine and then does nothing at all.
  if (found.length === 0 && body.trim() === "") found.push("has frontmatter but no instructions below it");

  return found;
}

async function listIfPresent(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Every command and skill file a plugin ships, in load order. */
export async function discoverCommands(plugin) {
  const found = [];

  for (const entry of await listIfPresent(path.join(plugin.dir, "commands"))) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push({
        kind: "command",
        name: entry.name.slice(0, -3),
        file: path.join(plugin.dir, "commands", entry.name)
      });
    }
  }

  for (const entry of await listIfPresent(path.join(plugin.dir, "skills"))) {
    if (entry.isDirectory()) {
      found.push({
        kind: "skill",
        name: entry.name,
        file: path.join(plugin.dir, "skills", entry.name, "SKILL.md")
      });
    }
  }

  return found.sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
}

/** Check every command and skill one plugin ships. */
export async function checkPlugin(plugin) {
  const commands = await discoverCommands(plugin);
  const results = [];

  for (const command of commands) {
    let markdown;
    try {
      markdown = await readFile(command.file, "utf8");
    } catch (error) {
      results.push({ ...command, problems: [`cannot be read: ${error.code ?? error.message}`] });
      continue;
    }
    results.push({ ...command, problems: checkCommandFile(markdown, command) });
  }

  return results;
}

async function main() {
  let failures = 0;
  let checked = 0;

  for (const plugin of PLUGINS) {
    const results = await checkPlugin(plugin);
    console.log(`\n${plugin.name} (${results.length} commands and skills)`);
    if (results.length === 0) {
      failures += 1;
      console.log("  FAIL  ships nothing loadable — the expected paths are gone");
      continue;
    }
    for (const result of results) {
      checked += 1;
      const label = `${result.kind} ${result.name}`;
      if (result.problems.length === 0) {
        console.log(`  PASS  ${label}`);
        continue;
      }
      failures += 1;
      console.log(`  FAIL  ${label}`);
      for (const problem of result.problems) {
        console.log(`        ${path.relative(repositoryRoot, result.file)}: ${problem}`);
      }
    }
  }

  console.log(`\n${checked - failures}/${checked} loadable across ${PLUGINS.length} plugins`);
  if (failures > 0) {
    console.log(`${failures} would be rejected by their host.`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
