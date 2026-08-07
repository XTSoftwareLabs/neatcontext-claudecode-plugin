// Every plugin's commands and skills have to stay loadable by their host.
//
// This runs the tools/e2e-commands.mjs contract inside `npm test`, which is
// what CI actually executes — the other tools/e2e-*.mjs drivers are run by
// hand, and a guard nobody runs is not a guard.
//
// The bug it exists for: `argument-hint: [context name or number]` is a YAML
// flow sequence, not a string. Claude Code coerces it with String() and never
// complained; Copilot type-checks it and refused five commands outright with
// "argument-hint must be a string". One host's leniency hid the defect in the
// other four plugins, so the check has to sweep every plugin, not just the one
// somebody reported.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PLUGINS,
  checkCommandFile,
  checkPlugin,
  classifyValue,
  discoverCommands,
  readFrontmatter,
  repositoryRoot
} from "../tools/e2e-commands.mjs";

test("every plugin ships a command surface to check", async () => {
  assert.deepEqual(
    PLUGINS.map((plugin) => plugin.name),
    ["Claude Code", "GitHub Copilot", "Kimi Code", "Codex", "pi"],
    "a new plugin must be added here, or its commands ship unchecked"
  );

  // Without this, a moved or renamed directory would make every check below
  // pass over an empty list and report success.
  for (const plugin of PLUGINS) {
    const commands = await discoverCommands(plugin);
    assert.ok(
      commands.length > 0,
      `${plugin.name} has no commands or skills at ${path.relative(repositoryRoot, plugin.dir)}`
    );
  }
});

for (const plugin of PLUGINS) {
  test(`${plugin.name} commands and skills all load`, async () => {
    const results = await checkPlugin(plugin);
    const broken = results
      .filter((result) => result.problems.length > 0)
      .map(
        (result) =>
          `${path.relative(repositoryRoot, result.file)}\n    ${result.problems.join("\n    ")}`
      );
    assert.deepEqual(broken, [], `${plugin.name} would reject:\n  ${broken.join("\n  ")}`);
  });
}

test("a placeholder in brackets is quoted so YAML yields a string", async () => {
  // The exact regression. Brackets are the natural way to write a placeholder
  // and the way Claude Code's own docs show it, so this will be reintroduced
  // unless something fails loudly.
  let hints = 0;
  for (const plugin of PLUGINS) {
    for (const command of await checkPlugin(plugin)) {
      const { fields } = readFrontmatter(await readFile(command.file, "utf8"));
      const hint = fields["argument-hint"];
      if (!hint) continue;
      hints += 1;
      assert.equal(
        hint.kind,
        "string",
        `${path.relative(repositoryRoot, command.file)}: argument-hint ${JSON.stringify(hint.raw)} is ${hint.kind}`
      );
    }
  }
  assert.ok(hints >= 6, `expected the commands that take arguments to carry hints, saw ${hints}`);
});

test("the contract catches what each host rejects", () => {
  // Guard the guard: these are the shapes that must keep failing, so the sweep
  // above cannot quietly turn into a no-op.
  const bad = [
    ["argument-hint: [context name]", "must be a string", "the flow sequence that broke Copilot"],
    ["argument-hint: {a: b}", "must be a string", "a flow mapping"],
    ['argument-hint: "unterminated', "must be a string", "an unbalanced quote"],
    ["disable-model-invocation: yes", "must be a boolean", "a non-boolean guard value"],
    ["allowed-tools: Bash: run", "nested key", "an unquoted colon-space"],
    ["allowed-tools: Read # note", "comment", "an unquoted comment marker"],
    ["argument-hnit: \"[x]\"", "unknown field", "a typo'd key"],
    ["  description: indented", "flat", "an indented pair"]
  ];
  for (const [line, expected, why] of bad) {
    const problems = checkCommandFile(`---\ndescription: fine\n${line}\n---\n\nBody.\n`, {
      kind: "command"
    });
    assert.ok(
      problems.some((problem) => problem.includes(expected)),
      `${why} must be reported: got ${JSON.stringify(problems)}`
    );
  }

  // And the shapes that must keep passing, including the real allowed-tools
  // line, whose parens, quotes and "${...}" must not read as YAML syntax.
  const good = [
    'allowed-tools: Read, Glob, Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)',
    'argument-hint: "[auto|ask|manual]"',
    "disable-model-invocation: true",
    "model: sonnet"
  ];
  for (const line of good) {
    assert.deepEqual(
      checkCommandFile(`---\ndescription: fine\n${line}\n---\n\nBody.\n`, { kind: "command" }),
      [],
      `${line} must be accepted`
    );
  }

  assert.equal(classifyValue("[a]").kind, "sequence");
  assert.equal(classifyValue('"[a]"').kind, "string");
  assert.equal(classifyValue('"[a]"').value, "[a]");
  // A CRLF checkout must not leave a stray \r on every value.
  assert.equal(readFrontmatter("---\r\ndescription: hi\r\n---\r\n\r\nBody.\r\n").fields.description.value, "hi");
});

test("a command with no instructions is reported", () => {
  assert.deepEqual(checkCommandFile("---\ndescription: fine\n---\n\n   \n", { kind: "command" }), [
    "has frontmatter but no instructions below it"
  ]);
  assert.deepEqual(checkCommandFile("Body with no frontmatter.\n", { kind: "command" }), [
    "does not open with a --- frontmatter fence"
  ]);
  assert.deepEqual(checkCommandFile("---\ndescription: fine\n", { kind: "command" }), [
    "never closes its --- frontmatter fence"
  ]);
  // Skills are identified by name, so a missing one is not loadable.
  assert.deepEqual(checkCommandFile("---\ndescription: fine\n---\n\nBody.\n", { kind: "skill" }), [
    'missing required "name"'
  ]);
});
