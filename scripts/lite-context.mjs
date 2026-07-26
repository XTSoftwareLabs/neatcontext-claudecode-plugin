// Lite contexts: the local, NeatContext-free half of the plugin.
//
// A lite context is created from Claude Code (`/neatcontext:create`) and lives
// entirely on disk, so it works with the NeatContext desktop app closed — or
// never installed. It is deliberately small: one domain profile, one knowledge
// folder, no extensions, no prompts. Anything richer is what the desktop app is
// for.
//
//   <home>/lite/<slug>-<suffix>/context.json   { schema, id, name, kind, ... }
//   <home>/lite/<slug>-<suffix>/profile.md     the domain profile, hand-editable
//
// <home> is the directory holding the companion discovery file, so
// NEATCONTEXT_COMPANION_FILE stays the single override that isolates tests.
//
// The knowledge folder is *referenced*, never copied: deleting a lite context
// removes the two files above and nothing of the user's.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoveryFilePath } from "./companion-client.mjs";

export const LITE_ID_PREFIX = "lite:";
const SCHEMA = 1;
const MAX_NAME_LENGTH = 80;
const MAX_LISTED_FILES = 200;
const MAX_LISTING_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__"]);

export class LiteContextError extends Error {}

export function liteHome() {
  return path.join(path.dirname(discoveryFilePath()), "lite");
}

export function isLiteId(id) {
  return typeof id === "string" && id.startsWith(LITE_ID_PREFIX);
}

function slugify(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lite-context";
}

function recordFor(directory, parsed) {
  if (parsed?.kind !== "lite" || typeof parsed.id !== "string" || typeof parsed.name !== "string") {
    return null;
  }
  return {
    id: parsed.id,
    name: parsed.name,
    kind: "lite",
    directory,
    knowledgeFolder: typeof parsed.knowledgeFolder === "string" ? parsed.knowledgeFolder : "",
    profilePath: path.join(directory, "profile.md"),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null
  };
}

// Every readable lite context, sorted by name. A directory that is missing or
// holds an unreadable context.json is skipped rather than failing the whole
// list: one broken context must not hide the others.
export async function listLite() {
  let entries;
  try {
    entries = await readdir(liteHome(), { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const directory = path.join(liteHome(), entry.name);
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
      const record = recordFor(directory, parsed);
      if (record) {
        records.push(record);
      }
    } catch {
      // Half-written or hand-broken: not a context we can serve.
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function readLite(id) {
  const contexts = await listLite();
  return contexts.find((context) => context.id === id) ?? null;
}

// The profile as written. A routing description is derived from this text and
// remembers its hash, so reading it back is how the plugin notices the user has
// since rewritten the profile and left the description describing the old one.
export async function readProfileText(record) {
  try {
    return await readFile(record.profilePath, "utf8");
  } catch {
    return null;
  }
}

async function directoryExists(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

// Creates the context from an already-answered wizard. Everything is validated
// before anything is written, and the context is assembled in a temp directory
// then renamed into place, so a failure never leaves a half-context behind.
export async function createLite({ name, knowledgeFolder, profile }) {
  const cleanName = (name ?? "").trim();
  if (cleanName.length === 0) {
    throw new LiteContextError("A context name is required.");
  }
  if (cleanName.length > MAX_NAME_LENGTH) {
    throw new LiteContextError(`Keep the context name under ${MAX_NAME_LENGTH} characters.`);
  }
  if (/[\r\n]/.test(cleanName)) {
    throw new LiteContextError("A context name must be a single line.");
  }

  const cleanProfile = (profile ?? "").trim();
  if (cleanProfile.length === 0) {
    throw new LiteContextError("The domain profile is empty. Describe what the context is for.");
  }

  const folder = path.resolve((knowledgeFolder ?? "").trim());
  if ((knowledgeFolder ?? "").trim().length === 0) {
    throw new LiteContextError("A knowledge folder is required.");
  }
  if (!(await directoryExists(folder))) {
    throw new LiteContextError(
      `No folder at ${folder}. Give me a path to an existing folder holding the TSGs, ` +
        "runbooks, or docs this context should use."
    );
  }

  const existing = await listLite();
  if (existing.some((context) => context.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new LiteContextError(
      `A lite context named "${cleanName}" already exists. Pick another name, or delete ` +
        "that one with `/neatcontext:delete`."
    );
  }

  const suffix = randomBytes(2).toString("hex");
  const directory = path.join(liteHome(), `${slugify(cleanName)}-${suffix}`);
  const staging = path.join(liteHome(), `.staging-${suffix}`);
  const record = {
    schema: SCHEMA,
    id: `${LITE_ID_PREFIX}${slugify(cleanName)}-${suffix}`,
    name: cleanName,
    kind: "lite",
    createdAt: new Date().toISOString(),
    knowledgeFolder: folder
  };

  // What actually lands on disk, which is not what the caller passed: it is
  // trimmed and given exactly one terminating newline. Anything that later
  // compares the profile against itself — a routing description remembering
  // what it was derived from — has to hash this, not the input.
  const profileText = `${cleanProfile}\n`;

  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "profile.md"), profileText, "utf8");
    await writeFile(
      path.join(staging, "context.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    record: recordFor(directory, record),
    profileText,
    knowledgeFileCount: (await listKnowledgeFiles(folder)).files.length
  };
}

// Removes the context's own two files. The knowledge folder is left alone —
// it is the user's, and the plugin only ever held a path to it.
export async function deleteLite(id) {
  const record = await readLite(id);
  if (!record) {
    return null;
  }
  await rm(record.directory, { recursive: true, force: true });
  return record;
}

// A shallow, capped listing of the knowledge folder. Lite has no index and no
// retrieval engine: this listing is what turns the client's own file tools from
// blind globbing into targeted reads.
export async function listKnowledgeFiles(folder, { limit = MAX_LISTED_FILES } = {}) {
  const files = [];
  let truncated = false;

  async function walk(directory, relative, depth) {
    if (truncated || depth > MAX_LISTING_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) {
        return;
      }
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const child = relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), child, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(child);
      }
    }
  }

  await walk(folder, "", 0);
  return { files, truncated };
}

function escapeMarkdown(value) {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function pathEntry(target) {
  if (path.isAbsolute(target) && !/[\r\n<>`]/.test(target)) {
    return `[\`${target}\`](${pathToFileURL(target).href})`;
  }
  return target;
}

export const LITE_MISSING_MESSAGE =
  "The lite context this session was using no longer exists on disk. Run " +
  "`/neatcontext:list` to pick another one, or `/neatcontext:create` to make a new one.";

// The `get_context` payload. Mirrors the desktop's contract — pointers to files
// the client reads itself, never compiled knowledge content — so what a user
// learns here transfers directly to a standard context.
export async function renderLiteContext(record) {
  const name = escapeMarkdown(record.name);
  const lines = [
    `# NeatContext Lite — connected context: ${name}`,
    "",
    `You are answering with the "${name}" lite context. Ground every answer in the ` +
      "domain profile and the local knowledge folder below. When those sources do not " +
      "cover the question, say so instead of guessing.",
    "",
    "## Domain profile (read this file in full before answering)",
    "",
    "It is your primary behavioral guide: it states what this context is for, what to " +
      "do, what to avoid, and how to behave.",
    "",
    `- ${pathEntry(record.profilePath)}`,
    "",
    "## Local knowledge folder (search it with your own file tools)",
    ""
  ];

  const folderExists = record.knowledgeFolder.length > 0 && (await directoryExists(record.knowledgeFolder));
  if (!folderExists) {
    lines.push(
      `The knowledge folder for this context (\`${record.knowledgeFolder}\`) is missing — it ` +
        "was moved, renamed, or is on a drive that is not mounted. Tell the user, and answer " +
        "from the domain profile alone until it is back."
    );
  } else {
    lines.push(`- ${pathEntry(record.knowledgeFolder)}`);
    lines.push("");
    const { files, truncated } = await listKnowledgeFiles(record.knowledgeFolder);
    if (files.length === 0) {
      lines.push(
        "The folder is empty. Tell the user to put the team's TSGs, runbooks, or docs in " +
          "it, then ask again."
      );
    } else {
      lines.push(
        truncated
          ? `Its first ${files.length} files (there are more — search the folder for anything not listed):`
          : `Its files (${files.length}):`
      );
      lines.push("");
      for (const file of files) {
        lines.push(`- ${file}`);
      }
    }
  }

  lines.push("");
  lines.push("## Rules");
  lines.push(
    '- Cite the exact file path when you rely on a source; never shorten a path with "...".'
  );
  lines.push("- Prefer these local sources over general knowledge for anything domain-specific.");
  lines.push(
    "- This is a lite context: one profile, one knowledge folder, and no extension tools. " +
      "There is no other NeatContext evidence to fetch on this connection."
  );
  // Session instructions are fixed at the handshake, so a session that started
  // on a standard context and switched to this one is still carrying NeatContext's
  // incident framing. This is the only place left that can speak, so it says so.
  lines.push(
    "- This is not an incident context unless the profile above says so. Any " +
      "incident-response contract described at connection does not apply here: the " +
      "domain profile defines the behavior and the shape of the answer."
  );

  return lines.join("\n");
}
