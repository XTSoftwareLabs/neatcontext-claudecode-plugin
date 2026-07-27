// The diff-coverage gate decides whether a pull request can merge, so the parts
// of it that could silently pass everything are tested directly: which files it
// polices, which lines it reads out of a diff, and how it turns V8's nested
// character ranges into covered and uncovered lines.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  characterCounts,
  isGatedFile,
  parseDiffLines,
  uncoveredLines
} from "../tools/diff-coverage.mjs";

describe("which files the gate polices", () => {
  it("takes shared runtime and host adapter code", () => {
    assert.equal(
      isGatedFile("plugins/claude-code/neatcontext/src/claude/mcp-bridge.mjs"),
      true
    );
    assert.equal(
      isGatedFile("plugins/claude-code/neatcontext/src/core/lite-context.mjs"),
      true
    );
  });

  it("leaves out tests, docs, and the gate's own tooling", () => {
    // A test file runs by definition; counting it would only dilute the gate.
    assert.equal(isGatedFile("tests/lite-context.test.mjs"), false);
    assert.equal(isGatedFile("tools/diff-coverage.mjs"), false);
    assert.equal(isGatedFile("README.md"), false);
    assert.equal(isGatedFile("plugins/claude-code/neatcontext/commands/use.md"), false);
  });
});

describe("reading the changed lines out of a diff", () => {
  it("claims every line on the + side of each hunk", () => {
    const diff = [
      "diff --git a/scripts/a.mjs b/scripts/a.mjs",
      "--- a/scripts/a.mjs",
      "+++ b/scripts/a.mjs",
      "@@ -10,0 +11,3 @@",
      "+one",
      "+two",
      "+three",
      "@@ -40,1 +44,1 @@",
      "-old",
      "+new"
    ].join("\n");

    assert.deepEqual(parseDiffLines(diff), new Map([["scripts/a.mjs", new Set([11, 12, 13, 44])]]));
  });

  it("defaults a hunk with no count to a single line", () => {
    const diff = ["+++ b/scripts/a.mjs", "@@ -3 +7 @@", "-old", "+new"].join("\n");
    assert.deepEqual(parseDiffLines(diff), new Map([["scripts/a.mjs", new Set([7])]]));
  });

  it("asks for nothing back from a pure deletion", () => {
    // Nothing was added, so there is no new line for a test to run.
    const diff = ["+++ b/scripts/a.mjs", "@@ -3,2 +2,0 @@", "-gone", "-also gone"].join("\n");
    assert.deepEqual(parseDiffLines(diff), new Map());
  });

  it("keeps each file's lines apart", () => {
    const diff = [
      "+++ b/scripts/a.mjs",
      "@@ -0,0 +1,1 @@",
      "+a",
      "diff --git a/scripts/b.mjs b/scripts/b.mjs",
      "+++ b/scripts/b.mjs",
      "@@ -0,0 +5,2 @@",
      "+b",
      "+b"
    ].join("\n");

    assert.deepEqual(
      parseDiffLines(diff),
      new Map([
        ["scripts/a.mjs", new Set([1])],
        ["scripts/b.mjs", new Set([5, 6])]
      ])
    );
  });
});

describe("turning V8 ranges into lines", () => {
  it("lets the innermost range win, so a dead block inside live code shows", () => {
    // V8 reports a never-taken branch as a zero-count range nested inside its
    // function's non-zero one.
    const counts = characterCounts(
      [
        { startOffset: 0, endOffset: 10, count: 1 },
        { startOffset: 3, endOffset: 6, count: 0 }
      ],
      10
    );

    assert.deepEqual([...counts], [1, 1, 1, 0, 0, 0, 1, 1, 1, 1]);
  });

  it("marks a stretch no range mentions as having no evidence", () => {
    assert.deepEqual([...characterCounts([{ startOffset: 0, endOffset: 2, count: 1 }], 4)], [1, 1, -1, -1]);
  });

  it("reports the body of a function nothing called", () => {
    const source = ["const a = 1;", "function never() {", "  return a;", "}", ""].join("\n");
    const bodyStart = source.indexOf("{", source.indexOf("function"));

    const missing = uncoveredLines(source, [
      { startOffset: 0, endOffset: source.length, count: 1 },
      { startOffset: bodyStart, endOffset: source.indexOf("}") + 1, count: 0 }
    ]);

    // The declaration on line 2 ran when the module loaded; the body and its
    // closing brace, which V8 puts inside the same zero-count range, did not.
    assert.deepEqual([...missing], [3, 4]);
  });

  it("counts a line as covered when anything on it ran", () => {
    // `if (x) return;` with the return never taken is a missed branch, not a
    // missed line, and this gate is about lines.
    const source = 'if (method === "ping") return {};\n';
    const missing = uncoveredLines(source, [
      { startOffset: 0, endOffset: source.length, count: 4 },
      { startOffset: source.indexOf("return"), endOffset: source.length - 1, count: 0 }
    ]);

    assert.deepEqual([...missing], []);
  });

  it("holds blank lines and comments against nobody", () => {
    const source = ["// a note", "", "   ", "const a = 1;", ""].join("\n");
    assert.deepEqual([...uncoveredLines(source, [{ startOffset: 0, endOffset: source.length, count: 1 }])], []);
  });

  it("reports every line of a file no process ever loaded", () => {
    // The comment goes in the list too: without a range to read, there is
    // nothing to tell code from prose. Noisy, but a new script that no test
    // imports has to fail the gate rather than sail through it.
    const source = ["// a note", "const a = 1;", "", "const b = 2;", ""].join("\n");
    assert.deepEqual([...uncoveredLines(source, [])], [1, 2, 4]);
  });
});
