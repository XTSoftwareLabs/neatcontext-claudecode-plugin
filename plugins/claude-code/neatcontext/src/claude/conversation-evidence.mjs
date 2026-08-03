// Claude Code transcript adapter for NeatContext conversation evidence.
//
// This is the only layer that knows Claude's JSONL shape. It deliberately
// discards system records, thinking, file bodies, raw shell commands, and
// successful read/search results before handing semantic blocks to the shared
// projector.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  createEvidenceDocument,
  normalizeEvidencePath,
  sanitizeEvidenceText,
  summarizeShellCommand
} from "../core/conversation-evidence.mjs";

const MAX_SOURCE_LINE_CHARS = 4_000_000;
const MAX_RESULT_CHARS = 3_200;
const MAX_RETAINED_BLOCKS = 8_000;
const MAX_RETAINED_CHARS = 8 * 1024 * 1024;
const MAX_PENDING_TOOLS = 1_024;
const INTERNAL_TOOLS = new Set([
  "todowrite",
  "toolsearch",
  "taskcreate",
  "taskupdate",
  "tasklist",
  "taskget"
]);
const MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "quick_edit",
  "target_edit"
]);
const READ_TOOLS = new Set(["read", "glob", "ls", "find", "webfetch", "web_fetch"]);
const SEARCH_TOOLS = new Set([
  "grep",
  "semantic_query",
  "semantic_grep",
  "semantic_show",
  "websearch",
  "web_search"
]);
const HARNESS_BLOCK_RE =
  /<(system-reminder|ide_opened_file|ide_selection|command-message|command-name|local-command-stdout|hook-output)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
const HARNESS_SELF_RE =
  /<\/?(?:system-reminder|ide_opened_file|ide_selection|command-message|command-name|local-command-stdout|hook-output)(?:\s[^>]*)?>/gi;
const RESULT_SIGNAL_RE =
  /\b(pass(?:ed|ing)?|fail(?:ed|ure|ing)?|error|warn(?:ing)?|tests?|specs?|build|lint|typecheck|compiled|created|modified|deleted|commit|branch|pull request|exit code|timeout|resolved|fixed)\b/i;
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,12}-\d+\b/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/gi;
const REPO_PATH_RE = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/g;
const WINDOWS_ABSOLUTE_PATH_RE =
  /[A-Za-z]:[\\/](?:[^\s'"<>|()[\]{}]+[\\/])+[^\s'"<>|()[\]{}]+/g;
const POSIX_ABSOLUTE_PATH_RE =
  /(?<![\w:/])\/(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+/g;

function sanitizeClaudeText(value, { maxChars = 24_000, projectRoot } = {}) {
  return sanitizeEvidenceText(value, { maxChars })
    .replace(WINDOWS_ABSOLUTE_PATH_RE, (match) =>
      normalizeEvidencePath(match, { projectRoot })
    )
    .replace(POSIX_ABSOLUTE_PATH_RE, (match) =>
      normalizeEvidencePath(match, { projectRoot })
    );
}

export function stripClaudeHarnessText(value, { projectRoot } = {}) {
  return sanitizeClaudeText(value, { maxChars: 30_000, projectRoot })
    .replace(HARNESS_BLOCK_RE, "")
    .replace(HARNESS_SELF_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractTextAnchors(text, projectRoot) {
  const anchors = [];
  for (const match of String(text ?? "").matchAll(TICKET_RE)) anchors.push(match[0]);
  for (const match of String(text ?? "").matchAll(REPO_PATH_RE)) {
    anchors.push(normalizeEvidencePath(match[1], { projectRoot }));
  }
  return unique(anchors);
}

function extractResultAnchors(text, { projectRoot, includeCommits = false } = {}) {
  const anchors = extractTextAnchors(text, projectRoot);
  if (includeCommits) {
    for (const match of String(text ?? "").matchAll(COMMIT_RE)) anchors.push(match[0]);
  }
  return unique(anchors);
}

function pathFromInput(input, projectRoot) {
  for (const key of ["file_path", "notebook_path", "path", "folder", "directory"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) {
      return normalizeEvidencePath(input[key], { projectRoot });
    }
  }
  return null;
}

function safeScalar(input, keys, maxChars = 220, projectRoot) {
  for (const key of keys) {
    if (typeof input?.[key] === "string" && input[key].trim()) {
      return sanitizeClaudeText(input[key], { maxChars, projectRoot });
    }
  }
  return "";
}

function toolCall(name, input, { turn, sourceLine, projectRoot }) {
  const lower = String(name ?? "unknown").toLowerCase();
  if (INTERNAL_TOOLS.has(lower)) return null;
  const pathValue = pathFromInput(input, projectRoot);

  if (MUTATION_TOOLS.has(lower)) {
    const title = pathValue ? `${name}: ${pathValue}` : `${name}: file change`;
    return {
      block: {
        kind: "tool_call",
        turn,
        title,
        text: "File content and edit payload omitted from the evidence view.",
        category: "mutation",
        anchors: pathValue ? [pathValue] : [],
        hints: ["mutation"],
        sourceLine
      },
      pending: { name, title, category: "mutation", anchors: pathValue ? [pathValue] : [] }
    };
  }

  if (READ_TOOLS.has(lower)) {
    const title = pathValue ? `${name}: ${pathValue}` : `${name}: source inspection`;
    return {
      block: {
        kind: "tool_call",
        turn,
        title,
        text: "Read content omitted; the saved context should record conclusions, not copied source.",
        category: "read",
        anchors: [],
        sourceLine
      },
      pending: { name, title, category: "read", anchors: [] }
    };
  }

  if (SEARCH_TOOLS.has(lower)) {
    const pattern = safeScalar(input, ["pattern", "query"], 180, projectRoot);
    const title = `${name}: ${pattern || "conversation or source search"}`;
    return {
      block: {
        kind: "tool_call",
        turn,
        title,
        text: pathValue ? `Scope: ${pathValue}` : "Search result bodies omitted.",
        category: "search",
        anchors: [],
        sourceLine
      },
      pending: { name, title, category: "search", anchors: [] }
    };
  }

  if (lower === "bash" || lower === "shell") {
    // Do not feed NeatContext's own command output back into the next compile.
    // Claude records Bash results in the same JSONL, so retaining an evidence
    // overview here would recursively turn projections into source evidence.
    if (/neatcontext-cli\.mjs["']?(?:\s|$)/i.test(String(input?.command ?? ""))) {
      return {
        block: null,
        pending: {
          name,
          title: "NeatContext internal command",
          category: "read",
          anchors: []
        }
      };
    }
    const command = summarizeShellCommand(input?.command);
    return {
      block: {
        kind: "tool_call",
        turn,
        title: `${name}: ${command.summary}`,
        text: "Raw command and arguments omitted from the evidence view.",
        category: command.category,
        hints: command.hints,
        anchors: [],
        sourceLine
      },
      pending: {
        name,
        title: `${name}: ${command.summary}`,
        category: command.category,
        anchors: [],
        hints: command.hints
      }
    };
  }

  if (lower === "agent" || lower === "task") {
    const description = safeScalar(input, ["description", "prompt"], 420, projectRoot);
    const title = `${name}: ${description || "delegated investigation"}`;
    return {
      block: {
        kind: "tool_call",
        turn,
        title,
        text: "Delegated task input bounded to its description.",
        category: "delegation",
        anchors: extractTextAnchors(description, projectRoot),
        sourceLine
      },
      pending: { name, title, category: "delegation", anchors: [] }
    };
  }

  const description = safeScalar(input, ["description", "query", "name"], 300, projectRoot);
  const title = `${name}${description ? `: ${description}` : ""}`;
  return {
    block: {
      kind: "tool_call",
      turn,
      title,
      text: "Tool payload omitted from the evidence view.",
      category: "other",
      anchors: extractTextAnchors(description, projectRoot),
      sourceLine
    },
    pending: { name, title, category: "other", anchors: [] }
  };
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function relevantResultText(value, { preferSignals = true, projectRoot } = {}) {
  const sanitized = sanitizeClaudeText(value, { maxChars: 24_000, projectRoot });
  if (!sanitized) return "";
  const lines = sanitized.split("\n").filter((line) => line.trim());
  if (lines.length <= 12) {
    return sanitizeClaudeText(lines.join("\n"), { maxChars: MAX_RESULT_CHARS, projectRoot });
  }

  const selected = new Set();
  if (preferSignals) {
    for (let index = 0; index < lines.length; index += 1) {
      if (RESULT_SIGNAL_RE.test(lines[index])) selected.add(index);
      if (selected.size >= 10) break;
    }
  }
  selected.add(0);
  selected.add(1);
  for (let index = Math.max(0, lines.length - 5); index < lines.length; index += 1) selected.add(index);
  return sanitizeClaudeText(
    [...selected]
      .sort((left, right) => left - right)
      .map((index) => lines[index])
      .join("\n"),
    { maxChars: MAX_RESULT_CHARS, projectRoot }
  );
}

function toolResult(part, pending, { turn, sourceLine, projectRoot }) {
  const isError = part?.is_error === true;
  const call = pending ?? {
    name: "tool",
    title: "Unmatched tool result",
    category: "other",
    anchors: []
  };
  const raw = resultText(part?.content);
  const anchors = unique([
    ...(call.anchors ?? []),
    ...extractResultAnchors(raw, {
      projectRoot,
      includeCommits: call.category === "commit"
    })
  ]);

  if (!isError && (call.category === "read" || call.category === "search")) return null;
  if (!isError && call.category === "other") return null;

  let text = "";
  if (isError || call.category === "verification" || call.category === "commit") {
    text = relevantResultText(raw, { projectRoot });
  } else if (call.category === "delegation") {
    text = sanitizeClaudeText(raw, { maxChars: 4_500, projectRoot });
  } else if (call.category === "mutation") {
    text = "The tool reported the file operation as successful; file body omitted.";
  } else {
    text = relevantResultText(raw, { projectRoot });
  }

  return {
    kind: "tool_result",
    turn,
    title: `${isError ? "Failed" : "Completed"}: ${call.title}`,
    text: text || (isError ? "The tool reported an error without readable text." : "The tool reported success."),
    category: call.category,
    outcome: isError ? "error" : "success",
    anchors,
    hints: unique([...(call.hints ?? []), isError ? "error" : ""]),
    sourceLine
  };
}

function intentionalTextBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
}

function markTurnClosers(blocks) {
  let lastAssistant = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].kind === "assistant") lastAssistant = index;
    if (blocks[index].kind === "user" && lastAssistant >= 0) {
      blocks[lastAssistant].hints = unique([...(blocks[lastAssistant].hints ?? []), "turn-close"]);
      lastAssistant = -1;
    }
  }
  if (lastAssistant >= 0) {
    blocks[lastAssistant].hints = unique([...(blocks[lastAssistant].hints ?? []), "turn-close"]);
  }
}

class ClaudeTranscriptParser {
  constructor({ projectRoot } = {}) {
    this.projectRoot = projectRoot;
    this.turn = 0;
    this.blocks = [];
    this.pendingTools = new Map();
    this.seen = new Set();
    this.retainedChars = 0;
    this.stats = {
      records: 0,
      malformedRecords: 0,
      oversizedRecords: 0,
      discardedRecords: 0,
      boundedBlocks: 0,
      boundedPendingTools: 0
    };
  }

  add(block) {
    if (!block) return;
    const key = [block.kind, block.turn, block.title, block.text, block.sourceLine].join("\u0000");
    if (this.seen.has(key)) return;
    const blockChars = String(block.title ?? "").length + String(block.text ?? "").length;
    if (
      this.blocks.length >= MAX_RETAINED_BLOCKS ||
      this.retainedChars + blockChars > MAX_RETAINED_CHARS
    ) {
      this.stats.boundedBlocks += 1;
      return;
    }
    this.seen.add(key);
    this.retainedChars += blockChars;
    this.blocks.push(block);
  }

  rememberTool(id, pending) {
    if (this.pendingTools.size >= MAX_PENDING_TOOLS) {
      this.pendingTools.delete(this.pendingTools.keys().next().value);
      this.stats.boundedPendingTools += 1;
    }
    this.pendingTools.set(id, pending);
  }

  ingest(entry, sourceLine) {
    this.stats.records += 1;
    if (!entry || typeof entry !== "object") {
      this.stats.discardedRecords += 1;
      return;
    }

    if (entry.type === "user") {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type !== "tool_result") continue;
          const pending = this.pendingTools.get(part.tool_use_id);
          this.pendingTools.delete(part.tool_use_id);
          this.add(toolResult(part, pending, {
            turn: this.turn,
            sourceLine,
            projectRoot: this.projectRoot
          }));
        }
      }

      if (entry.isCompactSummary === true) return;
      const texts = intentionalTextBlocks(content)
        .map((text) => stripClaudeHarnessText(text, { projectRoot: this.projectRoot }))
        .filter(Boolean);
      if (texts.length === 0) return;
      this.turn += 1;
      for (const text of texts) {
        this.add({
          kind: "user",
          turn: this.turn,
          title: "User request or clarification",
          text,
          category: "conversation",
          anchors: extractTextAnchors(text, this.projectRoot),
          hints: [],
          sourceLine
        });
      }
      return;
    }

    if (entry.type === "assistant") {
      const content = entry.message?.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part?.type === "text") {
          const text = stripClaudeHarnessText(part.text, { projectRoot: this.projectRoot });
          if (!text) continue;
          this.add({
            kind: "assistant",
            turn: this.turn,
            title: "Assistant conclusion or progress",
            text,
            category: "conversation",
            anchors: extractTextAnchors(text, this.projectRoot),
            hints: [],
            sourceLine
          });
          continue;
        }
        if (part?.type !== "tool_use") continue;
        const call = toolCall(part.name, part.input ?? {}, {
          turn: this.turn,
          sourceLine,
          projectRoot: this.projectRoot
        });
        if (!call) continue;
        this.add(call.block);
        if (typeof part.id === "string" && part.id) this.rememberTool(part.id, call.pending);
      }
      return;
    }

    this.stats.discardedRecords += 1;
  }

  document() {
    markTurnClosers(this.blocks);
    return createEvidenceDocument(this.blocks, { source: "claude-code", stats: this.stats });
  }
}

export function compileClaudeRecordsEvidence(records, options = {}) {
  const parser = new ClaudeTranscriptParser(options);
  let sourceLine = 0;
  for (const entry of Array.isArray(records) ? records : []) {
    sourceLine += 1;
    parser.ingest(entry, sourceLine);
  }
  return parser.document();
}

export async function readClaudeTranscriptEvidence(transcriptPath, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    throw new Error("No Claude transcript path is available for this session.");
  }
  const resolved = path.resolve(transcriptPath);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw new Error("The Claude transcript recorded for this session is unavailable.");

  const parser = new ClaudeTranscriptParser(options);
  const input = createReadStream(resolved, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let sourceLine = 0;
  for await (const line of lines) {
    sourceLine += 1;
    if (!line.trim()) continue;
    if (line.length > MAX_SOURCE_LINE_CHARS) {
      parser.stats.oversizedRecords += 1;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      parser.stats.malformedRecords += 1;
      continue;
    }
    parser.ingest(entry, sourceLine);
  }
  return parser.document();
}
