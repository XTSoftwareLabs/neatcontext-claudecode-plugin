// Conversation evidence is the privacy boundary between a host transcript and
// a NeatContext save. These tests protect both halves: the reusable projector
// and Claude's deliberately lossy JSONL adapter.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  createEvidenceDocument,
  normalizeEvidencePath,
  parseEvidenceIds,
  redactSensitiveText,
  renderEvidenceBlocks,
  renderEvidenceCoverage,
  renderEvidenceOverview,
  renderEvidenceSearch,
  sanitizeEvidenceText,
  summarizeShellCommand
} from "../plugins/claude-code/neatcontext/src/core/conversation-evidence.mjs";
import {
  compileClaudeRecordsEvidence,
  readClaudeTranscriptEvidence,
  stripClaudeHarnessText
} from "../plugins/claude-code/neatcontext/src/claude/conversation-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = path.join(
  root,
  "plugins",
  "claude-code",
  "neatcontext",
  "src",
  "claude",
  "neatcontext-cli.mjs"
);

let temp;
let companionFile;
let routingFile;
let transcriptFile;

const user = (content, extra = {}) => ({ type: "user", message: { content }, ...extra });
const assistant = (content) => ({ type: "assistant", message: { content } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, content, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError
});

function representativeRecords() {
  const longTestOutput = [
    "test run started",
    "suite checkout",
    ...Array.from({ length: 12 }, (_, index) => `detail ${index}`),
    "3 tests passed",
    "Authorization: Bearer this-must-not-survive",
    "build completed"
  ].join("\n");
  return [
    null,
    { type: "system", message: { content: "SYSTEM-PRIVATE" } },
    user(
      "<system-reminder>HARNESS-PRIVATE</system-reminder>\n" +
        "Implement PAY-123 retry handling in /project/src/payments/retry.ts. " +
        "Compare /home/alice/customer/secret.ts. API_KEY=sk-abcdefghijklmnopqrstuv"
    ),
    assistant([
      { type: "thinking", thinking: "CHAIN-OF-THOUGHT-PRIVATE" },
      { type: "text", text: "I will preserve the retry decision and verify it." },
      use("w1", "Write", {
        file_path: "/project/src/payments/retry.ts",
        content: "EDIT-BODY-PRIVATE password=hunter2"
      }),
      use("r1", "Read", { file_path: "/project/src/payments/retry.ts" }),
      use("g1", "Grep", { pattern: "retry", path: "/project/src" }),
      use("b1", "Bash", {
        command: "API_KEY=sk-raw-command-secret npm test -- --token raw-command-token"
      }),
      use("b2", "Bash", { command: "git commit -m secret-message" }),
      use("b3", "Bash", { command: "echo raw-shell-argument" }),
      use("e1", "Bash", { command: "node \"/plugin/neatcontext-cli.mjs\" evidence" }),
      use("a1", "Task", { description: "Find the PAY-123 retry root cause" }),
      use("f1", "WebFetch", { url: "https://example.test/private" }),
      use("c1", "CustomTool", { description: "custom check" }),
      use("c2", "CustomEmpty", {}),
      use("todo", "TodoWrite", { todos: [{ content: "PRIVATE-TODO" }] })
    ]),
    user([
      result("w1", "Wrote /project/src/payments/retry.ts"),
      result("r1", "READ-BODY-PRIVATE PASSWORD=read-secret"),
      result("g1", "SEARCH-BODY-PRIVATE /project/src/payments/retry.ts"),
      result("b1", longTestOutput),
      result("b2", "[main deadbeef] implemented retry"),
      result("b3", "raw-shell-output completed"),
      result("e1", "SELF-PROJECTION-PRIVATE build passed"),
      result(
        "a1",
        "Root cause: retry delay was unbounded. Fixed src/payments/retry.ts and verified PAY-123."
      ),
      result("f1", "WEB-BODY-PRIVATE build passed"),
      result("c1", "CUSTOM-BODY-PRIVATE build passed"),
      result("c2", "CUSTOM-EMPTY-PRIVATE build passed"),
      result("missing", [{ type: "text", text: "unmatched tool failed PASSWORD=nope" }], true),
      result("missing-object", { message: "unreadable error" }, true),
      { type: "text", text: "Keep the cap at 30 seconds because the provider rate-limits bursts." }
    ]),
    user("COMPACT-SUMMARY-PRIVATE", { isCompactSummary: true }),
    assistant([
      {
        type: "text",
        text:
          "Implemented capped exponential retry in src/payments/retry.ts; tests passed and " +
          "commit deadbeef landed. The 30-second cap is the durable decision."
      }
    ]),
    { type: "progress", data: "PROGRESS-PRIVATE" }
  ];
}

function runCli(args, { sessionId = "evidence-session" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: sessionId,
        CLAUDE_PROJECT_DIR: "/project",
        NEATCONTEXT_COMPANION_FILE: companionFile
      }
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("exit", () => resolve(output.trim()));
  });
}

async function pointSessionAtTranscript(value = transcriptFile) {
  await writeFile(
    routingFile,
    JSON.stringify({
      schema: 1,
      sessions: {
        "evidence-session": {
          updatedAt: "2026-08-03T00:00:00.000Z",
          save: { transcriptPath: value }
        }
      }
    })
  );
}

before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "neatcontext-evidence-test-"));
  companionFile = path.join(temp, "companion.json");
  routingFile = path.join(temp, "plugin-routing.json");
  transcriptFile = path.join(temp, "conversation.jsonl");
  await writeFile(
    transcriptFile,
    representativeRecords().filter(Boolean).map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("the host-neutral evidence projector", () => {
  it("redacts secret-shaped values, strips controls, and bounds text", () => {
    const input =
      "\u001b[31mAuthorization: Bearer abcdef\u001b[0m\r\n" +
      "password=hunter2 API_TOKEN=token-value cookie: yum\n" +
      "https://user:pass@example.test xoxb-abcdefghijklmnop eyJabcdefgh.ijklmnop.qrstuvwx\n" +
      "-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----\u0007";
    const redacted = redactSensitiveText(input);
    assert.doesNotMatch(redacted, /hunter2|token-value|user:pass|xoxb-|eyJabcdefgh|PRIVATE\n/);
    assert.match(redacted, /\[redacted/);

    const sanitized = sanitizeEvidenceText(input, { maxChars: 180 });
    assert.doesNotMatch(sanitized, /\u001b|\u0007|\r/);
    assert.ok(sanitized.length <= 180);
    assert.match(sanitizeEvidenceText("x".repeat(200), { maxChars: 32 }), /…$/);
    assert.equal(sanitizeEvidenceText(" a\n\n\n\n\nb \r\n"), "a\n\n\nb");
  });

  it("normalizes paths without exposing outside-project directories", () => {
    assert.equal(normalizeEvidencePath("/project/src/app.ts", { projectRoot: "/project" }), "src/app.ts");
    assert.equal(normalizeEvidencePath("/project", { projectRoot: "/project" }), "project");
    assert.equal(
      normalizeEvidencePath("/private/customer/secret.txt", { projectRoot: "/project" }),
      "[outside-project]/secret.txt"
    );
    assert.equal(normalizeEvidencePath("../private/secret.txt"), "[outside-project]/secret.txt");
    assert.equal(normalizeEvidencePath("./src\\app.ts"), "src/app.ts");
    assert.equal(
      normalizeEvidencePath("C:\\repo\\src\\app.ts", { projectRoot: "C:\\repo" }),
      "src/app.ts"
    );
    assert.equal(normalizeEvidencePath("  "), null);
  });

  it("summarizes command families without retaining raw arguments", () => {
    const cases = [
      ["", "shell command", "shell"],
      ["git commit -m private", "git commit", "commit"],
      ["git status --porcelain", "git status", "verification"],
      ["gh pr create --title private", "gh pr create", "commit"],
      ["gh issue view 123", "gh issue view", "verification"],
      ["npm test -- --token private", "npm test", "verification"],
      ["pnpm run typecheck --secret private", "pnpm run typecheck", "verification"],
      ["pytest tests/private_test.py", "pytest", "verification"],
      ["node --test tests/private.test.mjs", "node --test", "verification"],
      ["cargo check --token private", "cargo check", "verification"],
      ["go test ./...", "go test", "verification"],
      ["dotnet build private.sln", "dotnet build", "verification"],
      ["gradlew check --private", "gradlew check", "verification"],
      ["env API_KEY=secret curl https://user:pass@example.test", "shell command (curl)", "shell"]
    ];
    for (const [command, summary, category] of cases) {
      const actual = summarizeShellCommand(command);
      assert.equal(actual.summary, summary);
      assert.equal(actual.category, category);
      assert.doesNotMatch(actual.summary, /private|secret|token|user:pass/);
    }
  });

  it("assigns stable ids and renders bounded overview, search, detail, and coverage projections", () => {
    const raw = [
      { kind: "invalid", title: "discard me", text: "x" },
      { kind: "user", turn: 1, title: "Goal", text: "Fix PAY-123 retry timeout", anchors: ["PAY-123"] },
      {
        kind: "tool_call",
        turn: 1,
        title: "Edit: src/retry.ts",
        text: "payload omitted",
        category: "mutation",
        anchors: ["src/retry.ts", "src/retry.ts"]
      },
      {
        kind: "tool_result",
        turn: 1,
        title: "Failed tests",
        text: "retry test failed",
        category: "verification",
        outcome: "error"
      },
      {
        kind: "tool_result",
        turn: 1,
        title: "Completed tests",
        text: "retry tests passed",
        category: "verification",
        outcome: "success",
        anchors: ["tests/retry.test.ts"]
      },
      {
        kind: "assistant",
        turn: 1,
        title: "Decision",
        text: "Implemented a 30-second cap because the provider rate-limits bursts.",
        hints: ["turn-close", "resolution"]
      },
      { kind: "compaction", turn: 2, title: "Compaction", text: "Earlier work summarized." },
      { kind: "assistant", title: "Defaults", text: "Unknown category and outcome", category: "bad", outcome: "bad" },
      { kind: "assistant", title: "", text: "" }
    ];
    const document = createEvidenceDocument(raw, {
      source: "test-host",
      stats: { records: 9, ignored: -1, invalid: "no" }
    });
    assert.deepEqual(document.blocks.map((block) => block.id), [
      "B0001",
      "B0002",
      "B0003",
      "B0004",
      "B0005",
      "B0006",
      "B0007"
    ]);
    assert.deepEqual(document.stats, { records: 9 });
    assert.equal(document.blocks.at(-1).category, "other");
    assert.equal(document.blocks.at(-1).outcome, "unknown");

    const overview = renderEvidenceOverview(document, { maxChars: 2_400, maxBlocks: 5 });
    assert.match(overview, /High-signal trajectory/);
    assert.match(overview, /PAY-123/);
    assert.ok(overview.length <= 2_400);
    assert.match(renderEvidenceOverview(createEvidenceDocument([])), /No usable conversation evidence/);
    assert.match(
      renderEvidenceOverview(
        createEvidenceDocument([{ kind: "compaction", title: "Only compaction", text: "summary" }])
      ),
      /Only compaction/
    );

    const search = renderEvidenceSearch(document, "retry timeout", { limit: 2 });
    assert.match(search, /matching blocks; showing 2/);
    assert.match(search, /B0001/);
    assert.match(renderEvidenceSearch(document, "the and"), /Conversation evidence search/);
    assert.match(renderEvidenceSearch(document, "not-present"), /No conversation evidence matched/);
    assert.match(renderEvidenceSearch(document, "!!!"), /Pass one or more literal words/);

    assert.deepEqual(parseEvidenceIds("b1, B0004 junk B0004 B0 B999999999"), ["B0001", "B0004"]);
    const details = renderEvidenceBlocks(document, "B0005,B9999");
    assert.match(details, /Unknown block ids: B9999/);
    assert.match(details, /Neighbors:/);
    assert.match(renderEvidenceBlocks(document, "junk"), /Pass block ids/);

    const missing = renderEvidenceCoverage(document, { knowledge: [{ content: "PAY-123" }] });
    assert.match(missing, /Structural candidates absent/);
    assert.match(missing, /src\/retry\.ts|tests\/retry\.test\.ts/);
    assert.match(renderEvidenceCoverage(document, ""), /capture draft is empty/);
    const complete = renderEvidenceCoverage(document, {
      content:
        "PAY-123 src/retry.ts tests/retry.test.ts Implemented 30-second cap because provider rate-limits bursts"
    });
    assert.match(complete, /No obvious high-signal evidence gaps/);
  });
});

describe("the Claude transcript adapter", () => {
  it("keeps semantic work while dropping system, thought, payload, and routine read bodies", () => {
    const records = representativeRecords();
    const document = compileClaudeRecordsEvidence(records, { projectRoot: "/project" });
    const again = compileClaudeRecordsEvidence(records, { projectRoot: "/project" });
    assert.deepEqual(
      document.blocks.map(({ id, title }) => ({ id, title })),
      again.blocks.map(({ id, title }) => ({ id, title }))
    );
    assert.equal(document.source, "claude-code");
    assert.ok(document.stats.discardedRecords >= 3);

    const text = JSON.stringify(document);
    assert.match(text, /PAY-123/);
    assert.match(text, /src\/payments\/retry\.ts/);
    assert.match(text, /Bash: npm test/);
    assert.match(text, /Root cause: retry delay was unbounded/);
    assert.match(text, /\[redacted/);
    assert.doesNotMatch(
      text,
      /SYSTEM-PRIVATE|HARNESS-PRIVATE|CHAIN-OF-THOUGHT|EDIT-BODY|READ-BODY|SEARCH-BODY|WEB-BODY|CUSTOM-BODY|CUSTOM-EMPTY|SELF-PROJECTION|PRIVATE-TODO|COMPACT-SUMMARY|raw-command-argument|raw-command-secret|this-must-not-survive|home\/alice|customer/
    );
    assert.match(text, /\[outside-project\]\/secret\.ts/);
    assert.ok(document.blocks.some((block) => block.outcome === "error"));
    assert.ok(document.blocks.some((block) => block.category === "commit"));
    assert.ok(document.blocks.some((block) => block.hints.includes("turn-close")));
  });

  it("strips known harness wrappers but leaves intentional prose", () => {
    assert.equal(
      stripClaudeHarnessText(
        "before<command-name>private</command-name><ide_selection>private</ide_selection>after"
      ),
      "beforeafter"
    );
    assert.equal(stripClaudeHarnessText("<hook-output>private</hook-output>"), "");
    assert.equal(
      stripClaudeHarnessText("Use C:\\Users\\alice\\customer\\secret.ts", {
        projectRoot: "C:\\repo"
      }),
      "Use [outside-project]/secret.ts"
    );
  });

  it("streams JSONL, skips malformed and oversized records, and validates the source", async () => {
    const source = path.join(temp, "streaming.jsonl");
    await writeFile(
      source,
      [
        JSON.stringify(user("Verify src/a.ts")),
        "{malformed",
        "x".repeat(4_000_001),
        JSON.stringify(assistant([{ type: "text", text: "Verified src/a.ts." }]))
      ].join("\n") + "\n"
    );
    const document = await readClaudeTranscriptEvidence(source, { projectRoot: "/project" });
    assert.equal(document.stats.malformedRecords, 1);
    assert.equal(document.stats.oversizedRecords, 1);
    assert.equal(document.blocks.length, 2);

    await assert.rejects(() => readClaudeTranscriptEvidence(""), /No Claude transcript path/);
    await assert.rejects(
      () => readClaudeTranscriptEvidence(path.join(temp, "missing.jsonl")),
      /transcript recorded for this session is unavailable/
    );
    await mkdir(path.join(temp, "not-a-file"));
    await assert.rejects(
      () => readClaudeTranscriptEvidence(path.join(temp, "not-a-file")),
      /transcript recorded for this session is unavailable/
    );
  });

  it("bounds retained semantic text before constructing the evidence document", () => {
    const large = "decision because " + "x".repeat(30_000);
    const records = Array.from({ length: 300 }, () =>
      assistant([{ type: "text", text: large }])
    );
    const document = compileClaudeRecordsEvidence(records);
    assert.ok(document.stats.boundedBlocks > 0);
    assert.ok(document.blocks.length < records.length);
  });

  it("bounds unmatched tool-call state independently of retained evidence", () => {
    const calls = Array.from({ length: 1_025 }, (_, index) =>
      use(`read-${index}`, "Read", { file_path: "/project/src/a.ts" })
    );
    const document = compileClaudeRecordsEvidence([assistant(calls)], { projectRoot: "/project" });
    assert.equal(document.stats.boundedPendingTools, 1);
  });
});

describe("the Claude evidence CLI", () => {
  it("serves overview, literal search, exact blocks, and advisory capture coverage", async () => {
    await pointSessionAtTranscript();
    const overview = await runCli(["evidence"]);
    assert.match(overview, /NeatContext conversation evidence/);
    assert.match(overview, /privacy-filtered evidence/);
    assert.doesNotMatch(overview, /PRIVATE|raw-command-secret|this-must-not-survive/);

    const search = await runCli(["evidence", "--search", "retry provider"]);
    assert.match(search, /Conversation evidence search/);
    const id = /\[(B\d{4})/.exec(search)?.[1];
    assert.ok(id);
    assert.match(await runCli(["evidence", "--show", id]), /Conversation evidence details/);

    const capture = path.join(temp, "capture.json");
    await writeFile(capture, JSON.stringify({ schema: 1, knowledge: [{ content: "PAY-123" }] }));
    assert.match(
      await runCli(["evidence", "--coverage-from", capture]),
      /Evidence coverage review/
    );
  });

  it("reports missing arguments and unavailable inputs without searching for another transcript", async () => {
    await pointSessionAtTranscript();
    assert.match(await runCli(["evidence", "--search"]), /Pass literal terms/);
    assert.match(await runCli(["evidence", "--show"]), /Pass block ids/);
    assert.match(await runCli(["evidence", "--coverage-from"]), /Pass the capture draft/);
    const malformed = path.join(temp, "bad-capture.json");
    await writeFile(malformed, "{bad");
    assert.match(
      await runCli(["evidence", "--coverage-from", malformed]),
      /Could not read a valid capture JSON/
    );

    await writeFile(routingFile, JSON.stringify({ schema: 1, sessions: {} }));
    assert.match(await runCli(["evidence"]), /has not supplied a transcript location/);
    assert.match(
      await runCli(["evidence"], { sessionId: "" }),
      /Claude session has no id/
    );

    await pointSessionAtTranscript(path.join(temp, "gone.jsonl"));
    const unavailable = await runCli(["evidence"]);
    assert.match(unavailable, /transcript recorded for this session is unavailable/);
    assert.doesNotMatch(unavailable, /gone\.jsonl/);
  });
});
