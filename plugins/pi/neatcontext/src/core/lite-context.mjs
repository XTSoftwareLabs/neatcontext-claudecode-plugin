// Lite contexts: the local, NeatContext-free half of the plugin.
//
// A lite context is created from an AI coding host and lives entirely on disk, so it
// works with the NeatContext desktop app closed — or never installed. It is
// deliberately small: one domain profile, one primary knowledge folder,
// optional saved conversation notes, no extensions, and no prompts. Anything
// richer is what the desktop app is for.
//
//   <home>/lite/<slug>-<suffix>/context.json   { schema, id, name, kind, ... }
//   <home>/lite/<slug>-<suffix>/profile.md     the domain profile, hand-editable
//   <home>/lite/<slug>-<suffix>/knowledge/     conversation capture or update supplement
//
// <home> is the directory holding the companion discovery file, so
// NEATCONTEXT_COMPANION_FILE stays the single override that isolates tests.
//
// `/neatcontext-create` references a user-owned knowledge folder and never
// copies or deletes it. Saving more conversation work into one of those
// contexts writes a supplement inside the context directory. A context first
// made by `/neatcontext-save` owns its complete generated knowledge folder.

import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoveryFilePath } from "./companion-client.mjs";

export const LITE_ID_PREFIX = "lite:";
const SCHEMA = 1;
const MAX_NAME_LENGTH = 80;
const MAX_LISTED_FILES = 200;
const MAX_LISTING_DEPTH = 3;
const MAX_CAPTURE_FILES = 24;
const MAX_CAPTURE_FILE_BYTES = 256 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_ROUTING_DESCRIPTION = 240;
const UPDATE_LOCK_STALE_MS = 60_000;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__"]);

export class LiteContextError extends Error {}

function isConversationCapture(origin) {
  return (
    origin === "conversation" ||
    (typeof origin === "string" && origin.endsWith("-conversation"))
  );
}

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
  const storedKnowledgeFolder =
    typeof parsed.knowledgeFolder === "string" ? parsed.knowledgeFolder : "";
  const knowledgeFolder =
    storedKnowledgeFolder.length === 0
      ? ""
      : path.isAbsolute(storedKnowledgeFolder)
        ? storedKnowledgeFolder
        : path.resolve(directory, storedKnowledgeFolder);
  const knowledgeManaged =
    parsed.knowledgeManaged === true &&
    storedKnowledgeFolder === "knowledge";
  return {
    id: parsed.id,
    name: parsed.name,
    kind: "lite",
    directory,
    knowledgeFolder,
    knowledgeManaged,
    // `/create` contexts keep their user-owned folder untouched. Conversation
    // updates for those contexts live in this bundle-local supplement instead,
    // so every lite context can be updated without claiming ownership of linked
    // files. Older manifests need no migration: the path becomes real on the
    // first update.
    conversationKnowledgeFolder: knowledgeManaged ? null : path.join(directory, "knowledge"),
    routingDescription:
      typeof parsed.routingDescription === "string" ? parsed.routingDescription : "",
    capturedFrom: typeof parsed.capturedFrom === "string" ? parsed.capturedFrom : null,
    capturedFromConversation: isConversationCapture(parsed.capturedFrom),
    profilePath: path.join(directory, "profile.md"),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    revision:
      Number.isInteger(parsed.revision) && parsed.revision > 0
        ? parsed.revision
        : 1
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

function normalizeName(name) {
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
  return cleanName;
}

function normalizeProfile(profile) {
  const cleanProfile = (profile ?? "").trim();
  if (cleanProfile.length === 0) {
    throw new LiteContextError("The domain profile is empty. Describe what the context is for.");
  }
  if (Buffer.byteLength(cleanProfile, "utf8") > MAX_PROFILE_BYTES) {
    throw new LiteContextError("Keep the domain profile under 128 KB.");
  }
  return `${cleanProfile}\n`;
}

async function ensureUniqueName(cleanName) {
  const existing = await listLite();
  if (existing.some((context) => context.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new LiteContextError(
      `A lite context named "${cleanName}" already exists. Pick another name, or delete ` +
        "that one with `/neatcontext-delete`."
    );
  }
}

function contextPaths(cleanName) {
  const suffix = randomBytes(6).toString("hex");
  return {
    suffix,
    directory: path.join(liteHome(), `${slugify(cleanName)}-${suffix}`),
    staging: path.join(liteHome(), `.staging-${suffix}`)
  };
}

// Creates the context from an already-answered wizard. Everything is validated
// before anything is written, and the context is assembled in a temp directory
// then renamed into place, so a failure never leaves a half-context behind.
export async function createLite({ name, knowledgeFolder, profile }) {
  const cleanName = normalizeName(name);
  const profileText = normalizeProfile(profile);

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

  await ensureUniqueName(cleanName);

  const { suffix, directory, staging } = contextPaths(cleanName);
  const record = {
    schema: SCHEMA,
    id: `${LITE_ID_PREFIX}${slugify(cleanName)}-${suffix}`,
    name: cleanName,
    kind: "lite",
    createdAt: new Date().toISOString(),
    revision: 1,
    knowledgeFolder: folder
  };
  record.updatedAt = record.createdAt;

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

function normalizeRoutingDescription(value) {
  const description = (value ?? "").trim().replace(/\s+/g, " ");
  if (description.length === 0) {
    throw new LiteContextError(
      "The routing description is empty. Say what future requests belong in this context."
    );
  }
  if (description.length > MAX_ROUTING_DESCRIPTION) {
    throw new LiteContextError(
      `Keep the routing description under ${MAX_ROUTING_DESCRIPTION} characters.`
    );
  }
  return description;
}

function normalizeCaptureKnowledge(knowledge) {
  if (!Array.isArray(knowledge) || knowledge.length === 0) {
    throw new LiteContextError(
      "The capture has no knowledge files. Include at least knowledge/session-summary.md."
    );
  }
  if (knowledge.length > MAX_CAPTURE_FILES) {
    throw new LiteContextError(`Keep a conversation capture to ${MAX_CAPTURE_FILES} files or fewer.`);
  }

  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of knowledge) {
    const portablePath =
      typeof entry?.path === "string" ? entry.path.trim().replace(/\\/g, "/") : "";
    const parts = portablePath.split("/");
    if (
      portablePath.length === 0 ||
      portablePath.length > 180 ||
      path.posix.isAbsolute(portablePath) ||
      parts.length > MAX_LISTING_DEPTH + 1 ||
      parts.some(
        (part) =>
          part.length === 0 ||
          part.length > 100 ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*\u0000-\u001f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
    ) {
      throw new LiteContextError(
        `Invalid knowledge file path "${portablePath || "(empty)"}". Use a short relative path.`
      );
    }
    if (!portablePath.toLowerCase().endsWith(".md")) {
      throw new LiteContextError(
        `Knowledge file "${portablePath}" must be Markdown (a .md file).`
      );
    }
    const key = portablePath.toLowerCase();
    if (seen.has(key)) {
      throw new LiteContextError(`Knowledge file "${portablePath}" appears more than once.`);
    }
    if ([...seen].some((other) => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) {
      throw new LiteContextError(`Knowledge file "${portablePath}" conflicts with another path.`);
    }
    seen.add(key);

    const content = typeof entry?.content === "string" ? entry.content.trim() : "";
    if (content.length === 0) {
      throw new LiteContextError(`Knowledge file "${portablePath}" is empty.`);
    }
    const text = `${content}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CAPTURE_FILE_BYTES) {
      throw new LiteContextError(`Knowledge file "${portablePath}" is larger than 256 KB.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_CAPTURE_TOTAL_BYTES) {
      throw new LiteContextError("Keep the generated knowledge bundle under 1 MB.");
    }
    files.push({ path: portablePath, text });
  }

  if (!seen.has("session-summary.md")) {
    throw new LiteContextError(
      "The capture must include session-summary.md so a future session has an entry point."
    );
  }
  return files;
}

// Saves work already present in the host conversation. Unlike `createLite`,
// this owns the knowledge it writes. Relative storage is the portability
// contract: copying this one directory to another machine keeps every pointer
// valid without exposing or repairing an absolute path from the creator.
export async function createCapturedLite({
  name,
  profile,
  routingDescription,
  knowledge,
  capturedFrom = "conversation"
}) {
  const cleanName = normalizeName(name);
  const profileText = normalizeProfile(profile);
  const useWhen = normalizeRoutingDescription(routingDescription);
  const files = normalizeCaptureKnowledge(knowledge);
  await ensureUniqueName(cleanName);

  const { suffix, directory, staging } = contextPaths(cleanName);
  const record = {
    schema: SCHEMA,
    id: `${LITE_ID_PREFIX}${slugify(cleanName)}-${suffix}`,
    name: cleanName,
    kind: "lite",
    createdAt: new Date().toISOString(),
    revision: 1,
    knowledgeFolder: "knowledge",
    knowledgeManaged: true,
    capturedFrom: isConversationCapture(capturedFrom) ? capturedFrom : "conversation",
    routingDescription: useWhen
  };
  record.updatedAt = record.createdAt;

  try {
    await mkdir(path.join(staging, "knowledge"), { recursive: true });
    await writeFile(path.join(staging, "profile.md"), profileText, "utf8");
    for (const file of files) {
      const target = path.join(staging, "knowledge", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, "utf8");
    }
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
    routingDescription: useWhen,
    knowledgeFileCount: files.length
  };
}

function generatedKnowledgeFolder(record) {
  return record.knowledgeManaged
    ? record.knowledgeFolder
    : record.conversationKnowledgeFolder;
}

async function readGeneratedKnowledge(record) {
  const folder = generatedKnowledgeFolder(record);
  const { files, truncated } = await listKnowledgeFiles(folder, {
    limit: MAX_CAPTURE_FILES + 1
  });
  if (truncated || files.length > MAX_CAPTURE_FILES) {
    throw new LiteContextError(
      "This context has too many generated knowledge files to update safely."
    );
  }
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file,
      content: await readFile(path.join(folder, ...file.split("/")), "utf8")
    });
  }
  return entries;
}

// The optimistic-concurrency token used between drafting an update and
// applying it. Linked `/create` knowledge is deliberately excluded: save never
// rewrites those user-owned files. Everything save can replace is included.
export async function fingerprintLite(record) {
  const profile = await readProfileText(record);
  const knowledge = await readGeneratedKnowledge(record);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      id: record.id,
      name: record.name,
      knowledgeFolder: record.knowledgeFolder,
      knowledgeManaged: record.knowledgeManaged,
      routingDescription: record.routingDescription,
      capturedFrom: record.capturedFrom,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision
    })
  );
  hash.update("\0profile\0");
  hash.update(profile ?? "");
  for (const entry of knowledge) {
    hash.update("\0knowledge\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
  }
  return hash.digest("hex");
}

function knowledgeChanges(before, after) {
  const oldFiles = new Map(before.map((entry) => [entry.path, entry.content]));
  const newFiles = new Map(after.map((entry) => [entry.path, entry.text]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [file, content] of newFiles) {
    if (!oldFiles.has(file)) {
      added.push(file);
    } else if (oldFiles.get(file) !== content) {
      updated.push(file);
    }
  }
  for (const file of oldFiles.keys()) {
    if (!newFiles.has(file)) {
      removed.push(file);
    }
  }
  return { added, updated, removed };
}

function requireCurrentBase(record, actual, expected) {
  if (actual !== expected) {
    throw new LiteContextError(
      `The "${record.name}" context changed while this update was being prepared. ` +
        "Run `/neatcontext-save` again so the newer content is preserved."
    );
  }
}

async function prepareCapturedLiteUpdate({
  targetId,
  baseHash,
  name,
  profile,
  routingDescription,
  knowledge
}) {
  const record = await readLite(targetId);
  if (!record) {
    throw new LiteContextError("The lite context selected for this update no longer exists.");
  }
  const suppliedName = normalizeName(name);
  if (suppliedName.toLowerCase() !== record.name.toLowerCase()) {
    throw new LiteContextError(
      `The update was prepared for "${suppliedName}", but the target is "${record.name}".`
    );
  }
  if (typeof baseHash !== "string" || baseHash.length === 0) {
    throw new LiteContextError("The update has no base hash. Resolve the save target again.");
  }
  const currentHash = await fingerprintLite(record);
  requireCurrentBase(record, currentHash, baseHash);
  const profileText = normalizeProfile(profile);
  const useWhen = normalizeRoutingDescription(routingDescription);
  const files = normalizeCaptureKnowledge(knowledge);
  const currentKnowledge = await readGeneratedKnowledge(record);
  const changes = knowledgeChanges(currentKnowledge, files);
  const profileChanged = (await readProfileText(record)) !== profileText;
  const routingChanged = record.routingDescription !== useWhen;
  return {
    record,
    profileText,
    useWhen,
    files,
    changes,
    profileChanged,
    routingChanged,
    changed:
      profileChanged ||
      routingChanged ||
      changes.added.length > 0 ||
      changes.updated.length > 0 ||
      changes.removed.length > 0
  };
}

export async function previewCapturedLiteUpdate(capture) {
  return prepareCapturedLiteUpdate(capture);
}

async function acquireUpdateLock(record) {
  const lock = path.join(liteHome(), `.update-${slugify(record.id)}.lock`);
  try {
    await mkdir(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (Date.now() - (await stat(lock)).mtimeMs <= UPDATE_LOCK_STALE_MS) {
      throw new LiteContextError(
        `The "${record.name}" context is already being updated. Try again in a moment.`
      );
    }
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  return async () => {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  };
}

// Kept separate so the rollback path is directly testable. The backup lives
// beside both directories, making every rename stay on one filesystem.
export async function replaceLiteDirectory(directory, staging, backup) {
  await rename(directory, backup);
  try {
    await rename(staging, directory);
  } catch (error) {
    await rename(backup, directory);
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

// Replaces only plugin-owned state. For a saved context that is its complete
// knowledge folder; for a `/create` context it is a bundle-local conversation
// supplement. The linked folder is read-only throughout this operation.
export async function updateCapturedLite(capture) {
  const prepared = await prepareCapturedLiteUpdate(capture);
  if (!prepared.changed) {
    throw new LiteContextError(
      `The capture does not change the "${prepared.record.name}" context.`
    );
  }

  const release = await acquireUpdateLock(prepared.record);
  const suffix = randomBytes(6).toString("hex");
  const staging = path.join(liteHome(), `.staging-update-${suffix}`);
  const backup = path.join(liteHome(), `.backup-update-${suffix}`);
  try {
    const currentHash = await fingerprintLite(prepared.record);
    requireCurrentBase(prepared.record, currentHash, capture.baseHash);

    await cp(prepared.record.directory, staging, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await rm(path.join(staging, "knowledge"), { recursive: true, force: true });
    await mkdir(path.join(staging, "knowledge"), { recursive: true });
    await writeFile(path.join(staging, "profile.md"), prepared.profileText, "utf8");
    for (const file of prepared.files) {
      const target = path.join(staging, "knowledge", ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, "utf8");
    }

    const stored = JSON.parse(
      await readFile(path.join(prepared.record.directory, "context.json"), "utf8")
    );
    const now = new Date().toISOString();
    const manifest = {
      ...stored,
      schema: SCHEMA,
      id: prepared.record.id,
      name: prepared.record.name,
      kind: "lite",
      createdAt: prepared.record.createdAt ?? stored.createdAt ?? now,
      updatedAt: now,
      revision: prepared.record.revision + 1,
      routingDescription: prepared.useWhen,
      updatedFrom: "pi-conversation"
    };
    if (prepared.record.knowledgeManaged) {
      manifest.knowledgeFolder = "knowledge";
      manifest.knowledgeManaged = true;
      delete manifest.conversationKnowledgeFolder;
    } else {
      manifest.knowledgeFolder = stored.knowledgeFolder;
      manifest.knowledgeManaged = false;
      manifest.conversationKnowledgeFolder = "knowledge";
    }
    await writeFile(
      path.join(staging, "context.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    // Recheck after staging so a hand edit made during preparation is not
    // replaced. Other save processes respect the lock; this catches everything
    // outside that protocol.
    requireCurrentBase(
      prepared.record,
      await fingerprintLite(prepared.record),
      capture.baseHash
    );

    await replaceLiteDirectory(prepared.record.directory, staging, backup);

    return {
      record: recordFor(prepared.record.directory, manifest),
      profileText: prepared.profileText,
      routingDescription: prepared.useWhen,
      knowledgeFileCount: prepared.files.length,
      changes: prepared.changes,
      profileChanged: prepared.profileChanged,
      routingChanged: prepared.routingChanged
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }
}

// A captured context is already an export bundle. Import reads only the
// portable, generated shape and creates a fresh local id, so a teammate can
// keep the shared folder unchanged and can rename the local copy if necessary.
export async function importCapturedLite({ bundleFolder, name }) {
  const supplied = (bundleFolder ?? "").trim();
  if (supplied.length === 0) {
    throw new LiteContextError("A captured context bundle folder is required.");
  }
  const source = path.resolve(supplied);
  if (!(await directoryExists(source))) {
    throw new LiteContextError(`No captured context bundle at ${source}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(source, "context.json"), "utf8"));
  } catch {
    throw new LiteContextError(`Could not read a valid context.json from ${source}.`);
  }
  if (
    manifest?.schema !== SCHEMA ||
    manifest.kind !== "lite" ||
    manifest.knowledgeManaged !== true ||
    manifest.knowledgeFolder !== "knowledge" ||
    !isConversationCapture(manifest.capturedFrom)
  ) {
    throw new LiteContextError(
      "That folder is not a portable conversation context bundle."
    );
  }

  let profile;
  try {
    profile = await readFile(path.join(source, "profile.md"), "utf8");
  } catch {
    throw new LiteContextError("The captured context bundle has no readable profile.md.");
  }

  const knowledgeFolder = path.join(source, "knowledge");
  const { files, truncated } = await listKnowledgeFiles(knowledgeFolder, {
    limit: MAX_CAPTURE_FILES + 1
  });
  if (truncated || files.length > MAX_CAPTURE_FILES) {
    throw new LiteContextError(
      `The captured context bundle has more than ${MAX_CAPTURE_FILES} knowledge files.`
    );
  }
  const knowledge = [];
  for (const file of files) {
    knowledge.push({
      path: file,
      content: await readFile(path.join(knowledgeFolder, ...file.split("/")), "utf8")
    });
  }

  return createCapturedLite({
    name: typeof name === "string" && name.trim().length > 0 ? name : manifest.name,
    profile,
    routingDescription: manifest.routingDescription,
    knowledge,
    capturedFrom: manifest.capturedFrom
  });
}

// Removes the context directory. A `/create` context only points at the user's
// knowledge folder, so that folder is left alone. A `/save` context owns its
// generated knowledge inside this directory, so it is removed with the bundle.
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
  "`/neatcontext-list` to pick another one, or `/neatcontext-create` to make a new one.";

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

  if (!record.knowledgeManaged && record.conversationKnowledgeFolder) {
    const { files } = await listKnowledgeFiles(record.conversationKnowledgeFolder);
    if (files.length > 0) {
      lines.push("");
      lines.push("## Conversation knowledge saved into this context");
      lines.push("");
      lines.push(`- ${pathEntry(record.conversationKnowledgeFolder)}`);
      lines.push("");
      lines.push(`Its files (${files.length}):`);
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
    "- This is a lite context: one profile, local knowledge, and no extension tools. " +
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
