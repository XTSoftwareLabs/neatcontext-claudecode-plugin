// Host-neutral conversation evidence for NeatContext saves.
//
// Host adapters translate their transcript format into a small sequence of
// semantic blocks. This module assigns stable block ids, scores the blocks for
// durable value, and renders bounded projections for the model that is already
// handling an explicit save. It never reads a host transcript and never writes
// a compiled view to disk.

import path from "node:path";

export const EVIDENCE_SCHEMA = 1;
export const DEFAULT_OVERVIEW_CHARS = 14_000;
export const DEFAULT_DETAIL_CHARS = 20_000;

const MAX_BLOCK_TEXT = 24_000;
const MAX_TITLE_TEXT = 240;
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const PRIVATE_KEY_RE =
  /-----BEGIN [^-\r\n]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END [^-\r\n]+-----/gi;
const AUTH_HEADER_RE = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi;
const NAMED_SECRET_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|cookie)\b(\s*[=:]\s*)(["']?)[^\s"',;]+/gi;
const ENV_SECRET_RE =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|COOKIE))=([^\s]+)/g;
const TOKEN_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIAL_RE = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

const ALLOWED_KINDS = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "compaction"
]);
const ALLOWED_CATEGORIES = new Set([
  "conversation",
  "mutation",
  "read",
  "search",
  "verification",
  "commit",
  "shell",
  "delegation",
  "other"
]);
const ALLOWED_OUTCOMES = new Set(["success", "error", "unknown"]);

const DECISION_RE =
  /\b(decid(?:e|ed|ing)|root cause|because|must|should|prefer|never|avoid|constraint|trade-?off)\b/i;
const COMPLETION_RE =
  /\b(implemented|completed|fixed|resolved|verified|validated|passed|shipped|landed|root cause)\b/i;
const ERROR_RE = /\b(error|failed|failure|broken|blocked|cannot|crash|timeout|regression)\b/i;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do",
  "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it",
  "its", "of", "on", "or", "our", "so", "that", "the", "their", "then", "this", "to",
  "was", "we", "were", "what", "when", "where", "which", "with", "you", "your"
]);

function clampInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars < 80) return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  const marker = "\n…[bounded evidence omitted]…\n";
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining * 0.7);
  const tail = Math.floor(remaining * 0.3);
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`;
}

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(PRIVATE_KEY_RE, "[redacted private key]")
    .replace(AUTH_HEADER_RE, "$1[redacted]")
    .replace(NAMED_SECRET_RE, "$1$2[redacted]")
    .replace(ENV_SECRET_RE, "$1=[redacted]")
    .replace(TOKEN_PREFIX_RE, "[redacted token]")
    .replace(JWT_RE, "[redacted token]")
    .replace(URL_CREDENTIAL_RE, "$1[redacted]@");
}

export function sanitizeEvidenceText(value, { maxChars = MAX_BLOCK_TEXT } = {}) {
  const bounded = clampInteger(maxChars, MAX_BLOCK_TEXT, 32, 1_000_000);
  const clean = redactSensitiveText(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return truncateText(clean, bounded);
}

function pathFlavor(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") ? path.win32 : path.posix;
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

export function normalizeEvidencePath(value, { projectRoot } = {}) {
  const clean = sanitizeEvidenceText(value, { maxChars: 800 }).replace(/^['"]|['"]$/g, "");
  if (!clean) return null;
  const api = pathFlavor(clean);
  const root = typeof projectRoot === "string" && projectRoot.trim() ? projectRoot.trim() : null;
  const absolute = api.isAbsolute(clean);

  if (absolute && root) {
    const rootApi = pathFlavor(root);
    const relative = rootApi.relative(rootApi.resolve(root), rootApi.resolve(clean));
    if (relative === "" || (!relative.startsWith("..") && !rootApi.isAbsolute(relative))) {
      return slash(relative || rootApi.basename(clean));
    }
  }

  if (absolute) {
    return `[outside-project]/${slash(api.basename(clean))}`;
  }

  const normalized = slash(api.normalize(clean)).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    return `[outside-project]/${slash(api.basename(clean))}`;
  }
  return normalized;
}

function commandWords(command) {
  const first = String(command ?? "")
    .split(/\r?\n|&&|\|\||;|\|/, 1)[0]
    .trim();
  return first.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) ?? [];
}

function safeCommandHead(words, count) {
  return words
    .slice(0, count)
    .map((word) => sanitizeEvidenceText(word, { maxChars: 80 }))
    .filter(Boolean)
    .join(" ");
}

// Shell commands are intentionally summarized by family. Raw commands often
// carry environment values or credentials and are not a safe evidence surface.
export function summarizeShellCommand(command) {
  const redacted = redactSensitiveText(command);
  const words = commandWords(redacted);
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "env")) {
    words.shift();
  }
  const executable = pathFlavor(words[0] ?? "").basename(words[0] ?? "").toLowerCase();
  const second = (words[1] ?? "").toLowerCase();
  const third = (words[2] ?? "").toLowerCase();

  if (!executable) return { summary: "shell command", category: "shell", hints: [] };

  if (executable === "git") {
    const durable = new Set(["commit", "push", "merge", "rebase", "revert", "cherry-pick", "tag"]);
    const verification = new Set(["status", "diff", "log", "show"]);
    return {
      summary: safeCommandHead(words, 2) || "git command",
      category: durable.has(second) ? "commit" : verification.has(second) ? "verification" : "shell",
      hints: durable.has(second) ? ["commit"] : verification.has(second) ? ["verification"] : []
    };
  }

  if (executable === "gh" && (second === "pr" || second === "issue")) {
    const durable = new Set(["create", "merge", "close", "comment", "edit", "reopen"]);
    return {
      summary: safeCommandHead(words, 3),
      category: durable.has(third) ? "commit" : "verification",
      hints: durable.has(third) ? ["commit"] : ["verification"]
    };
  }

  const packageRunner = new Set(["npm", "pnpm", "yarn", "bun"]);
  if (packageRunner.has(executable)) {
    const verification =
      second === "test" ||
      second === "check" ||
      second === "lint" ||
      second === "build" ||
      (second === "run" && /^(test|check|lint|build|typecheck|verify)/.test(third));
    return {
      summary: safeCommandHead(words, second === "run" ? 3 : 2),
      category: verification ? "verification" : "shell",
      hints: verification ? ["verification"] : []
    };
  }

  const verification =
    executable === "pytest" ||
    executable === "jest" ||
    executable === "vitest" ||
    executable === "tsc" ||
    (executable === "node" && words.includes("--test")) ||
    (executable === "cargo" && (second === "test" || second === "check")) ||
    (executable === "go" && second === "test") ||
    (executable === "dotnet" && (second === "test" || second === "build")) ||
    ((executable === "mvn" || executable.startsWith("gradle")) && words.some((word) => /test|check|build/i.test(word)));
  const summaryWords = new Set(["pytest", "jest", "vitest", "tsc"]).has(executable) ? 1 : 2;
  return {
    summary: verification
      ? safeCommandHead(words, summaryWords)
      : `shell command (${sanitizeEvidenceText(executable, { maxChars: 50 })})`,
    category: verification ? "verification" : "shell",
    hints: verification ? ["verification"] : []
  };
}

function uniqueStrings(values, limit = 24) {
  const result = [];
  for (const value of values ?? []) {
    const clean = sanitizeEvidenceText(value, { maxChars: 180 });
    if (!clean || clean.includes("[redacted") || result.includes(clean)) continue;
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function scoreBlock(block, index, total) {
  let score = total <= 1 ? 0 : Math.round((index / (total - 1)) * 12);
  if (block.kind === "user") score += 34;
  if (block.kind === "assistant") score += 16;
  if (block.kind === "compaction") score += 2;
  if (block.kind === "tool_call") score += 5;
  if (block.kind === "tool_result") score += 4;

  if (block.category === "mutation") score += 25;
  if (block.category === "verification") score += 22;
  if (block.category === "commit") score += 28;
  if (block.category === "delegation") score += 10;
  if (block.category === "read" || block.category === "search") score += 2;
  if (block.outcome === "error") score += 27;
  if (block.outcome === "success" && block.category === "verification") score += 12;
  if (block.outcome === "success" && block.category === "mutation") score += 8;

  const prose = `${block.title}\n${block.text}`;
  if (DECISION_RE.test(prose)) score += 10;
  if (COMPLETION_RE.test(prose)) score += 9;
  if (ERROR_RE.test(prose)) score += 6;
  if (block.hints.includes("turn-close")) score += 9;
  if (block.hints.includes("resolution")) score += 10;
  return score;
}

function normalizeBlock(raw, index) {
  const kind = ALLOWED_KINDS.has(raw?.kind) ? raw.kind : null;
  if (!kind) return null;
  const title = sanitizeEvidenceText(raw.title, { maxChars: MAX_TITLE_TEXT });
  const text = sanitizeEvidenceText(raw.text);
  if (!title && !text) return null;
  const category = ALLOWED_CATEGORIES.has(raw.category) ? raw.category : "other";
  const outcome = ALLOWED_OUTCOMES.has(raw.outcome) ? raw.outcome : "unknown";
  return {
    id: `B${String(index + 1).padStart(4, "0")}`,
    kind,
    role: kind === "tool_call" || kind === "tool_result" ? kind : kind,
    turn: Number.isInteger(raw.turn) && raw.turn >= 0 ? raw.turn : 0,
    title,
    text,
    category,
    outcome,
    anchors: uniqueStrings(raw.anchors),
    hints: uniqueStrings(raw.hints, 12),
    sourceLine: Number.isInteger(raw.sourceLine) && raw.sourceLine > 0 ? raw.sourceLine : null,
    sequence: index
  };
}

export function createEvidenceDocument(rawBlocks, { source = "conversation", stats = {} } = {}) {
  const normalized = [];
  for (const raw of Array.isArray(rawBlocks) ? rawBlocks : []) {
    const block = normalizeBlock(raw, normalized.length);
    if (block) normalized.push(block);
  }
  const blocks = normalized.map((block, index) => ({
    ...block,
    importance: scoreBlock(block, index, normalized.length)
  }));
  const cleanStats = Object.fromEntries(
    Object.entries(stats).filter(([, value]) => Number.isInteger(value) && value >= 0)
  );
  return {
    schema: EVIDENCE_SCHEMA,
    source: sanitizeEvidenceText(source, { maxChars: 80 }) || "conversation",
    blocks,
    stats: cleanStats
  };
}

function labelFor(block) {
  const parts = [block.id, `turn ${block.turn}`, block.kind];
  if (block.category !== "conversation" && block.category !== "other") parts.push(block.category);
  if (block.outcome !== "unknown") parts.push(block.outcome);
  return `[${parts.join(" | ")}]`;
}

function briefLimit(block) {
  if (block.kind === "user") return 1_100;
  if (block.kind === "assistant") return 850;
  if (block.kind === "tool_result") return 650;
  return 420;
}

function renderBlock(block, { full = false } = {}) {
  const lines = [labelFor(block)];
  if (block.title) lines.push(block.title);
  const limit = full ? 7_000 : briefLimit(block);
  const text = truncateText(block.text, limit);
  if (text && text !== block.title) lines.push(text);
  if (full) {
    lines.push(
      `Neighbors: ${block.sequence > 0 ? `B${String(block.sequence).padStart(4, "0")}` : "(start)"} <- ${block.id} -> ` +
        `${block._total && block.sequence + 1 < block._total ? `B${String(block.sequence + 2).padStart(4, "0")}` : "(end)"}`
    );
  }
  return lines.join("\n");
}

function lastIndex(blocks, predicate) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index])) return index;
  }
  return -1;
}

function selectOverviewBlocks(document, { maxChars, maxBlocks }) {
  const blocks = document.blocks;
  if (blocks.length === 0) return [];
  const selected = new Set();
  let used = 0;

  const add = (index, required = false) => {
    if (index < 0 || selected.has(index) || selected.size >= maxBlocks) return;
    const cost = renderBlock(blocks[index]).length + 2;
    if (!required && used + cost > maxChars) return;
    if (required && selected.size > 0 && used + cost > maxChars) return;
    selected.add(index);
    used += cost;
  };

  add(blocks.findIndex((block) => block.kind === "user"), true);
  add(lastIndex(blocks, (block) => block.kind === "user"), true);
  add(lastIndex(blocks, (block) => block.kind === "assistant"), true);
  add(lastIndex(blocks, (block) => block.outcome === "error"));
  add(lastIndex(blocks, (block) => block.category === "mutation"));
  add(lastIndex(blocks, (block) => block.category === "verification" || block.category === "commit"));

  for (let index = Math.max(0, blocks.length - 8); index < blocks.length; index += 1) {
    if (blocks[index].importance >= 20) add(index);
  }

  const ranked = blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => right.block.importance - left.block.importance || right.index - left.index);
  for (const item of ranked) add(item.index);
  if (selected.size === 0) add(blocks.length - 1, true);
  return [...selected].sort((left, right) => left - right).map((index) => blocks[index]);
}

function renderTrajectory(blocks, totalBlocks) {
  const output = [];
  let previous = -1;
  for (const block of blocks) {
    const gap = block.sequence - previous - 1;
    if (gap > 0) output.push(`… ${gap} lower-signal block${gap === 1 ? "" : "s"} omitted …`);
    output.push(renderBlock(block));
    previous = block.sequence;
  }
  const tail = totalBlocks - previous - 1;
  if (tail > 0) output.push(`… ${tail} lower-signal block${tail === 1 ? "" : "s"} omitted …`);
  return output.join("\n\n");
}

export function renderEvidenceOverview(
  document,
  { maxChars = DEFAULT_OVERVIEW_CHARS, maxBlocks = 48 } = {}
) {
  const boundedChars = clampInteger(maxChars, DEFAULT_OVERVIEW_CHARS, 2_000, 80_000);
  const boundedBlocks = clampInteger(maxBlocks, 48, 1, 200);
  const selected = selectOverviewBlocks(document, {
    maxChars: Math.max(1_000, boundedChars - 1_300),
    maxBlocks: boundedBlocks
  });
  const lines = [
    "# NeatContext conversation evidence",
    "",
    "Ephemeral, privacy-filtered evidence for this explicit save. It is a projection, not the saved context; distill conclusions and never copy it as a transcript.",
    `Source blocks: ${document.blocks.length}; high-signal blocks shown: ${selected.length}.`,
    "Use `evidence --search \"literal terms\"` for a focused view and `evidence --show \"B0001,B0002\"` to inspect exact sanitized blocks.",
    "",
    "## High-signal trajectory",
    "",
    renderTrajectory(selected, document.blocks.length) || "(No usable conversation evidence was found.)"
  ];
  return truncateText(lines.join("\n"), boundedChars);
}

function queryTerms(query) {
  const terms = sanitizeEvidenceText(query, { maxChars: 300 })
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const unique = [...new Set(terms.filter((term) => term.length > 1))];
  const meaningful = unique.filter((term) => !STOPWORDS.has(term));
  return meaningful.length > 0 ? meaningful : unique;
}

function occurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  while (count < 20) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + Math.max(1, needle.length);
  }
  return count;
}

function searchSnippet(block, terms) {
  const lines = `${block.title}\n${block.text}`.split("\n");
  let matched = lines.findIndex((line) => {
    const lower = line.toLocaleLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  if (matched < 0) matched = 0;
  const start = Math.max(0, matched - 1);
  const end = Math.min(lines.length, matched + 2);
  return truncateText(lines.slice(start, end).join("\n").trim(), 1_000);
}

export function renderEvidenceSearch(document, query, { limit = 12 } = {}) {
  const cleanQuery = sanitizeEvidenceText(query, { maxChars: 300 });
  const terms = queryTerms(cleanQuery);
  if (terms.length === 0) {
    return "Pass one or more literal words with `evidence --search \"terms\"`. Regular expressions are not accepted.";
  }
  const phrase = cleanQuery.toLocaleLowerCase();
  const matches = [];
  for (const block of document.blocks) {
    const haystack = `${block.title}\n${block.text}\n${block.anchors.join(" ")}`.toLocaleLowerCase();
    const counts = terms.map((term) => occurrences(haystack, term));
    const matchedTerms = counts.filter((count) => count > 0).length;
    if (matchedTerms === 0) continue;
    const countScore = counts.reduce((sum, count) => sum + Math.min(count, 5), 0);
    const phraseBonus = phrase.length > 2 && haystack.includes(phrase) ? 20 : 0;
    matches.push({
      block,
      score: matchedTerms * 18 + countScore * 2 + phraseBonus + block.importance * 0.2
    });
  }
  matches.sort((left, right) => right.score - left.score || right.block.sequence - left.block.sequence);
  const chosen = matches.slice(0, clampInteger(limit, 12, 1, 50));
  if (chosen.length === 0) {
    return `No conversation evidence matched the literal terms: ${terms.join(", ")}.`;
  }
  return [
    `# Conversation evidence search: ${cleanQuery}`,
    "",
    `${matches.length} matching blocks; showing ${chosen.length} in relevance order. Use \`evidence --show "B…"\` for full sanitized content.`,
    "",
    ...chosen.map(({ block }) => `${labelFor(block)}\n${searchSnippet(block, terms)}`)
  ].join("\n\n");
}

export function parseEvidenceIds(value) {
  const ids = [];
  for (const token of String(value ?? "").split(/[\s,]+/)) {
    const match = /^B(\d{1,8})$/i.exec(token.trim());
    if (!match) continue;
    const number = Number(match[1]);
    if (number <= 0) continue;
    const id = `B${String(number).padStart(4, "0")}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function renderEvidenceBlocks(document, requested, { maxChars = DEFAULT_DETAIL_CHARS } = {}) {
  const ids = Array.isArray(requested) ? requested : parseEvidenceIds(requested);
  if (ids.length === 0) return "Pass block ids with `evidence --show \"B0001,B0002\"`.";
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const missing = ids.filter((id) => !byId.has(id));
  const found = ids.map((id) => byId.get(id)).filter(Boolean);
  const parts = ["# Conversation evidence details"];
  if (missing.length > 0) parts.push(`Unknown block ids: ${missing.join(", ")}.`);
  for (const block of found) {
    parts.push(renderBlock({ ...block, _total: document.blocks.length }, { full: true }));
  }
  return truncateText(parts.join("\n\n"), clampInteger(maxChars, DEFAULT_DETAIL_CHARS, 2_000, 100_000));
}

function semanticTokens(block) {
  return queryTerms(`${block.title} ${block.text}`)
    .filter((term) => term.length >= 5 && !/^\d+$/.test(term))
    .slice(0, 12);
}

function candidateSummary(block) {
  return `${labelFor(block)} ${truncateText(block.title || block.text.replaceAll("\n", " "), 260)}`;
}

// Advisory only: exact anchors catch structural omissions, while semantic
// candidates tell the model which conclusions deserve a deliberate comparison.
// The function never rejects a save or treats lexical overlap as proof.
export function renderEvidenceCoverage(document, draft) {
  const draftText = sanitizeEvidenceText(
    typeof draft === "string" ? draft : JSON.stringify(draft ?? {}),
    { maxChars: 1_000_000 }
  ).toLocaleLowerCase();
  if (!draftText.trim()) return "The capture draft is empty, so evidence coverage cannot be reviewed.";

  const structural = [];
  const semantic = [];
  for (const block of [...document.blocks].sort((a, b) => b.importance - a.importance)) {
    const durableCategory = new Set(["mutation", "verification", "commit"]).has(block.category);
    const missingAnchors = block.anchors.filter(
      (anchor) => !draftText.includes(anchor.toLocaleLowerCase())
    );
    if ((durableCategory || block.outcome === "error") && missingAnchors.length > 0) {
      structural.push({ block, missingAnchors });
    }

    if (
      semantic.length < 6 &&
      (block.kind === "user" || block.kind === "assistant") &&
      (DECISION_RE.test(`${block.title}\n${block.text}`) || COMPLETION_RE.test(`${block.title}\n${block.text}`))
    ) {
      const tokens = semanticTokens(block);
      const overlap = tokens.filter((term) => draftText.includes(term)).length;
      if (tokens.length >= 3 && overlap < 2) semantic.push(block);
    }
  }

  const uniqueStructural = [];
  const seenAnchorSets = new Set();
  for (const item of structural) {
    const key = item.missingAnchors.map((anchor) => anchor.toLocaleLowerCase()).sort().join("|");
    if (!key || seenAnchorSets.has(key)) continue;
    seenAnchorSets.add(key);
    uniqueStructural.push(item);
    if (uniqueStructural.length >= 10) break;
  }

  const lines = [
    "# Evidence coverage review",
    "",
    "Advisory only: inspect these candidates and preserve only durable, verified conclusions. Lexical absence is not proof that the draft is incomplete."
  ];
  if (uniqueStructural.length === 0 && semantic.length === 0) {
    lines.push("", "No obvious high-signal evidence gaps were detected.");
    return lines.join("\n");
  }
  if (uniqueStructural.length > 0) {
    lines.push("", "## Structural candidates absent from the draft", "");
    for (const { block, missingAnchors } of uniqueStructural) {
      lines.push(`- ${candidateSummary(block)}; anchors: ${missingAnchors.join(", ")}`);
    }
  }
  if (semantic.length > 0) {
    lines.push("", "## Semantic candidates to compare deliberately", "");
    for (const block of semantic) lines.push(`- ${candidateSummary(block)}`);
  }
  lines.push("", "Use `evidence --show \"B…\"` before revising any claim whose meaning is unclear.");
  return lines.join("\n");
}
