import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionId } from "./session.mjs";
import { neatContextHome } from "./storage-home.mjs";

const SELECTION_SCHEMA = 2;

export function selectionFilePath() {
  return path.join(neatContextHome(), "plugin-selection.json");
}

export function sessionSelectionFilePath(id) {
  return path.join(neatContextHome(), "plugin-sessions", `${id}.json`);
}

export function sessionSelectionDirectory() {
  return path.join(neatContextHome(), "plugin-sessions");
}

async function readSelectionFrom(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));

    if (
      parsed?.schema === SELECTION_SCHEMA &&
      typeof parsed.contextId === "string" &&
      parsed.contextId.trim().length > 0
    ) {
      return {
        contextId: parsed.contextId.trim(),
        contextName:
          typeof parsed.contextName === "string" && parsed.contextName.trim().length > 0
            ? parsed.contextName.trim()
            : parsed.contextId.trim(),
        available: true,
        legacy: false
      };
    }

    // Compatibility with plugin-created Context selections from schema 1.
    const legacyId =
      typeof parsed?.liteContextId === "string"
        ? parsed.liteContextId
        : parsed?.kind === "lite" && typeof parsed?.contextId === "string"
          ? parsed.contextId
          : null;
    if (legacyId && legacyId.trim().length > 0) {
      return {
        contextId: legacyId.trim(),
        contextName:
          typeof parsed.contextName === "string" && parsed.contextName.trim().length > 0
            ? parsed.contextName.trim()
            : legacyId.trim(),
        available: true,
        legacy: true
      };
    }

    // A pre-schema bare contextId cannot be resolved safely. Keep enough detail
    // for status to explain the stale selection once, then clear it.
    if (typeof parsed?.contextId === "string" && parsed.contextId.trim().length > 0) {
      return {
        contextId: parsed.contextId.trim(),
        contextName:
          typeof parsed.contextName === "string" && parsed.contextName.trim().length > 0
            ? parsed.contextName.trim()
            : parsed.contextId.trim(),
        available: false,
        legacy: true
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function readSelection() {
  const id = sessionId();
  const file = id ? sessionSelectionFilePath(id) : selectionFilePath();
  const selection = await readSelectionFrom(file);
  if (selection?.available === true && selection.legacy === true) {
    await writeJson(file, {
      schema: SELECTION_SCHEMA,
      contextId: selection.contextId,
      contextName: selection.contextName
    });
    return { ...selection, legacy: false };
  }
  if (selection?.available === false) {
    await rm(file, { force: true }).catch(() => undefined);
  }
  return selection;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function writeSelection(selection) {
  const id = sessionId();
  const file = id ? sessionSelectionFilePath(id) : selectionFilePath();
  await writeJson(file, {
    schema: SELECTION_SCHEMA,
    contextId: selection.contextId,
    contextName: selection.contextName
  });
}

export async function clearSelection() {
  const id = sessionId();
  const file = id ? sessionSelectionFilePath(id) : selectionFilePath();
  await rm(file, { force: true }).catch(() => undefined);
}
