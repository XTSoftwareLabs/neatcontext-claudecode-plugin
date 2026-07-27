// Saving a conversation is the model-assisted half of lite contexts. The model
// writes a small JSON spec; these tests start at that boundary and protect what
// the plugin itself promises: validation, atomic storage, portability, reuse,
// sharing, and ownership-aware deletion.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./fake-companion.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let home;
let discoveryFile;
let serial = 0;

const childEnv = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "",
  NEATCONTEXT_COMPANION_FILE: discoveryFile
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-save-test-"));
  discoveryFile = path.join(home, "companion.json");
  process.env.NEATCONTEXT_COMPANION_FILE = discoveryFile;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { recursive: true, force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv()
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

function validCapture(overrides = {}) {
  return {
    schema: 1,
    name: "Conversation Capture",
    profile:
      "# Conversation Capture\n\n" +
      "## Purpose\nPreserve the checkout recovery work.\n\n" +
      "## What to do\nUse the recorded decisions.\n\n" +
      "## What to avoid\nDo not invent deployment state.\n\n" +
      "## Behavior\nSeparate verified facts from open work.",
    routingDescription: "Checkout recovery, payment retries, PAY-* tickets, and worker restarts",
    knowledge: [
      {
        path: "session-summary.md",
        content:
          "# Session summary\n\n" +
          "Implemented retry backoff in `src/payments/retry.ts`; focused tests passed."
      },
      {
        path: "implementation/decisions.md",
        content: "# Decisions\n\nUse capped exponential backoff to protect the provider."
      }
    ],
    ...overrides
  };
}

async function writeCapture(capture = validCapture()) {
  const file = path.join(home, `capture-${serial++}.json`);
  await writeFile(file, JSON.stringify(capture));
  return file;
}

async function saveCapture(capture = validCapture(), { consume = false } = {}) {
  const file = await writeCapture(capture);
  const args = ["save", "--from", file];
  if (consume) args.push("--consume");
  const output = await cli(...args);
  return { file, output };
}

function bundleFrom(output) {
  return /Lite context folder:\s+(.+)/.exec(output)?.[1];
}

function openSession() {
  const child = spawn(process.execPath, [path.join(scripts, "mcp-bridge.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv()
  });
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    }
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    send,
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "save-test", version: "1" }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      return response;
    },
    close: () => closeSession(child)
  };
}

describe("saving the current conversation", () => {
  it("creates a self-contained context without connecting it", async () => {
    const { file, output } = await saveCapture(validCapture(), { consume: true });
    const bundle = bundleFrom(output);

    assert.deepEqual(output.split(/\r?\n/), [
      `Lite context folder: ${bundle}`,
      `Profile path: ${path.join(bundle, "profile.md")}`,
      `Knowledge folder: ${path.join(bundle, "knowledge")}`,
      "Use command: /neatcontext:use Conversation Capture"
    ]);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    assert.match(await cli("status"), /No context is connected yet/);

    const manifest = JSON.parse(await readFile(path.join(bundle, "context.json"), "utf8"));
    assert.equal(manifest.knowledgeFolder, "knowledge");
    assert.equal(manifest.knowledgeManaged, true);
    assert.equal(manifest.capturedFrom, "claude-code-conversation");
    assert.equal(manifest.routingDescription, validCapture().routingDescription);
    assert.equal(
      await readFile(path.join(bundle, "knowledge", "session-summary.md"), "utf8"),
      `${validCapture().knowledge[0].content}\n`
    );
    assert.equal(
      await readFile(path.join(bundle, "knowledge", "implementation", "decisions.md"), "utf8"),
      `${validCapture().knowledge[1].content}\n`
    );
  });

  it("remains routable from its portable manifest when the local routing cache is empty", async () => {
    const { output } = await saveCapture();
    const manifest = JSON.parse(
      await readFile(path.join(bundleFrom(output), "context.json"), "utf8")
    );
    await writeFile(
      path.join(home, "plugin-routing.json"),
      JSON.stringify({ cards: { [manifest.id]: { useWhen: "", aliases: [] } } })
    );

    const use = await cli("use", "Conversation Capture");
    assert.match(use, /Connected the "Conversation Capture" lite context/);
    assert.doesNotMatch(use, /no routing description yet/);

    const session = openSession();
    try {
      const { instructions } = (await session.handshake()).result;
      assert.match(instructions, /Conversation Capture.*Checkout recovery, payment retries/);

      const preview = await session.send("tools/call", {
        name: "preview_context",
        arguments: { context: "Conversation Capture" }
      });
      assert.match(preview.result.content[0].text, /Checkout recovery, payment retries/);
      assert.match(preview.result.content[0].text, /implementation\/decisions\.md/);
    } finally {
      await session.close();
    }
  });

  it("deletes generated knowledge with a saved context and says so before doing it", async () => {
    const { output } = await saveCapture();
    const bundle = bundleFrom(output);

    const preview = await cli("delete", "Conversation Capture");
    assert.match(preview, /generated knowledge folder .* will be deleted/s);
    assert.equal((await readdir(path.join(bundle, "knowledge"))).length, 2);

    const deleted = await cli("delete", "Conversation Capture", "--yes");
    assert.match(deleted, /generated knowledge folder .* was deleted with it/s);
    await assert.rejects(readFile(path.join(bundle, "context.json"), "utf8"), { code: "ENOENT" });
  });

  it("keeps the capture spec after validation fails so the model can repair it", async () => {
    const file = await writeCapture(validCapture({ routingDescription: "" }));
    assert.match(await cli("save", "--from", file, "--consume"), /routing description is empty/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).name, "Conversation Capture");
  });

  it("reports a missing spec and malformed JSON without creating a context", async () => {
    assert.match(await cli("save"), /Pass the generated conversation capture/);
    assert.match(
      await cli("save", "--from", path.join(home, "missing.json")),
      /Could not read a valid conversation capture/
    );
    const malformed = path.join(home, "malformed.json");
    await writeFile(malformed, "{not json");
    assert.match(await cli("save", "--from", malformed), /Could not read a valid conversation capture/);
    assert.match(await cli("list", "--lite"), /Lite contexts:\s+\(none/);
  });

  it("surfaces an unexpected filesystem failure and leaves no half-context", async () => {
    await writeFile(path.join(home, "lite"), "not a directory");
    const file = await writeCapture();
    const output = await cli("save", "--from", file);
    assert.match(output, /NeatContext plugin error:/);
    assert.equal(await readFile(path.join(home, "lite"), "utf8"), "not a directory");
  });

  it("still saves when the optional local routing cache cannot be updated", async () => {
    await mkdir(path.join(home, "plugin-routing.json"));
    const { output } = await saveCapture();
    assert.match(output, /Lite context folder:/);

    await rm(path.join(home, "plugin-routing.json"), { recursive: true, force: true });
    assert.doesNotMatch(await cli("use", "Conversation Capture"), /no routing description yet/);
  });
});

describe("capture validation", () => {
  it("rejects invalid identity, profile, routing, and knowledge shapes", async () => {
    const { createCapturedLite } = await import("../scripts/lite-context.mjs");
    const hugeProfile = "p".repeat(128 * 1024 + 1);
    const hugeFile = "x".repeat(256 * 1024 + 1);
    const totalTooLarge = [
      { path: "session-summary.md", content: "x".repeat(220 * 1024) },
      ...Array.from({ length: 4 }, (_, index) => ({
        path: `part-${index}.md`,
        content: "x".repeat(220 * 1024)
      }))
    ];
    const tooMany = [
      { path: "session-summary.md", content: "summary" },
      ...Array.from({ length: 24 }, (_, index) => ({
        path: `part-${index}.md`,
        content: "content"
      }))
    ];

    const cases = [
      [validCapture({ name: "" }), /context name is required/i],
      [validCapture({ name: "x".repeat(81) }), /under 80 characters/],
      [validCapture({ name: "two\nlines" }), /single line/],
      [validCapture({ profile: "  " }), /domain profile is empty/i],
      [validCapture({ profile: hugeProfile }), /profile under 128 KB/],
      [validCapture({ routingDescription: "" }), /routing description is empty/i],
      [validCapture({ routingDescription: "r".repeat(241) }), /under 240 characters/],
      [validCapture({ knowledge: [] }), /no knowledge files/],
      [validCapture({ knowledge: "not-an-array" }), /no knowledge files/],
      [validCapture({ knowledge: tooMany }), /24 files or fewer/],
      [
        validCapture({ knowledge: [{ path: "../session-summary.md", content: "x" }] }),
        /Invalid knowledge file path/
      ],
      [
        validCapture({ knowledge: [{ path: "session-summary.txt", content: "x" }] }),
        /must be Markdown/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "x" },
            { path: "SESSION-SUMMARY.md", content: "y" }
          ]
        }),
        /appears more than once/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "x" },
            { path: "session-summary.md/details.md", content: "y" }
          ]
        }),
        /conflicts with another path/
      ],
      [
        validCapture({ knowledge: [{ path: "session-summary.md", content: "  " }] }),
        /is empty/
      ],
      [
        validCapture({
          knowledge: [
            { path: "session-summary.md", content: "summary" },
            { path: "huge.md", content: hugeFile }
          ]
        }),
        /larger than 256 KB/
      ],
      [validCapture({ knowledge: totalTooLarge }), /under 1 MB/],
      [
        validCapture({ knowledge: [{ path: "decisions.md", content: "x" }] }),
        /must include session-summary/
      ]
    ];

    for (const [capture, expected] of cases) {
      await assert.rejects(() => createCapturedLite(capture), expected);
    }
  });

  it("rejects every non-portable path form before writing", async () => {
    const { createCapturedLite } = await import("../scripts/lite-context.mjs");
    const badPaths = [
      "",
      "x".repeat(181),
      "/session-summary.md",
      "a/b/c/d/session-summary.md",
      "a//session-summary.md",
      "./session-summary.md",
      "../session-summary.md",
      "bad?/session-summary.md",
      "folder./session-summary.md",
      `${"x".repeat(101)}/session-summary.md`,
      "CON.md"
    ];
    for (const badPath of badPaths) {
      await assert.rejects(
        () =>
          createCapturedLite(
            validCapture({ knowledge: [{ path: badPath, content: "summary" }] })
          ),
        /Invalid knowledge file path/
      );
    }
  });

  it("refuses a duplicate name", async () => {
    const { createCapturedLite } = await import("../scripts/lite-context.mjs");
    await createCapturedLite(validCapture());
    await assert.rejects(() => createCapturedLite(validCapture()), /already exists/);
  });

  it("keeps listing an older lite manifest that omitted its knowledge path", async () => {
    const legacy = path.join(home, "lite", "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, "context.json"),
      JSON.stringify({ kind: "lite", id: "lite:legacy", name: "Legacy Lite" })
    );
    assert.match(await cli("list", "--lite"), /Legacy Lite/);
  });
});

describe("sharing a captured context", () => {
  it("imports a portable copy under a new local name and leaves the shared source alone", async () => {
    const { output } = await saveCapture();
    const original = bundleFrom(output);
    const shared = path.join(home, "shared-bundle");
    await cp(original, shared, { recursive: true });
    await cli("delete", "Conversation Capture", "--yes");

    const imported = await cli("import", "--from", shared, "--name", "Team Checkout Context");
    assert.match(imported, /Imported the "Team Checkout Context" conversation context/);
    assert.match(imported, /2 files/);
    assert.match(imported, /Connect it with:\s+\/neatcontext:use Team Checkout Context/);
    assert.match(imported, /shared source folder .* was left untouched/s);
    assert.equal(JSON.parse(await readFile(path.join(shared, "context.json"), "utf8")).name, "Conversation Capture");

    await rm(path.join(home, "plugin-routing.json"), { force: true });
    assert.doesNotMatch(await cli("use", "Team Checkout"), /no routing description yet/);
  });

  it("uses the bundle name when no local override is supplied", async () => {
    const { output } = await saveCapture(
      validCapture({ name: "Shared Original", profile: "# Shared Original\n\n## Purpose\nReuse it." })
    );
    const original = bundleFrom(output);
    const shared = path.join(home, "shared-original");
    await cp(original, shared, { recursive: true });
    await cli("delete", "Shared Original", "--yes");

    assert.match(await cli("import", "--from", shared), /Imported the "Shared Original"/);
  });

  it("rejects missing, malformed, non-portable, incomplete, and oversized bundles", async () => {
    assert.match(await cli("import"), /bundle folder is required/);
    assert.match(
      await cli("import", "--from", path.join(home, "not-there")),
      /No captured context bundle/
    );

    const malformed = path.join(home, "bundle-malformed");
    await mkdir(malformed);
    await writeFile(path.join(malformed, "context.json"), "{bad json");
    assert.match(await cli("import", "--from", malformed), /Could not read a valid context.json/);

    const wrong = path.join(home, "bundle-wrong");
    await mkdir(wrong);
    await writeFile(
      path.join(wrong, "context.json"),
      JSON.stringify({ kind: "lite", knowledgeFolder: "C:\\private-docs" })
    );
    assert.match(await cli("import", "--from", wrong), /not a portable conversation context/);

    const noProfile = path.join(home, "bundle-no-profile");
    await mkdir(noProfile);
    await writeFile(
      path.join(noProfile, "context.json"),
      JSON.stringify({
        schema: 1,
        kind: "lite",
        name: "No Profile",
        knowledgeManaged: true,
        knowledgeFolder: "knowledge",
        capturedFrom: "claude-code-conversation",
        routingDescription: "missing profile"
      })
    );
    assert.match(await cli("import", "--from", noProfile), /no readable profile.md/);

    const oversized = path.join(home, "bundle-oversized");
    await mkdir(path.join(oversized, "knowledge"), { recursive: true });
    await writeFile(
      path.join(oversized, "context.json"),
      JSON.stringify({
        schema: 1,
        kind: "lite",
        name: "Oversized",
        knowledgeManaged: true,
        knowledgeFolder: "knowledge",
        capturedFrom: "claude-code-conversation",
        routingDescription: "too many files"
      })
    );
    await writeFile(path.join(oversized, "profile.md"), "# Oversized\n\n## Purpose\nTest.");
    for (let index = 0; index < 25; index += 1) {
      await writeFile(
        path.join(oversized, "knowledge", index === 0 ? "session-summary.md" : `${index}.md`),
        "content"
      );
    }
    assert.match(await cli("import", "--from", oversized), /more than 24 knowledge files/);
  });

  it("surfaces an unexpected filesystem failure while importing", async () => {
    const { output } = await saveCapture();
    const shared = path.join(home, "shared-for-failure");
    await cp(bundleFrom(output), shared, { recursive: true });
    await rm(path.join(home, "lite"), { recursive: true, force: true });
    await writeFile(path.join(home, "lite"), "not a directory");

    assert.match(await cli("import", "--from", shared), /NeatContext plugin error:/);
  });
});

describe("the Claude-facing save workflow", () => {
  it("keeps fresh creation separate and defines a privacy-aware model capture", async () => {
    const root = path.dirname(scripts);
    const saveCommand = await readFile(path.join(root, "commands", "save.md"), "utf8");
    const createCommand = await readFile(path.join(root, "commands", "create.md"), "utf8");
    const importCommand = await readFile(path.join(root, "commands", "import.md"), "utf8");

    assert.match(saveCommand, /disable-model-invocation: true/);
    assert.match(saveCommand, /model active in this session/);
    assert.match(saveCommand, /session-summary\.md/);
    assert.match(saveCommand, /Never write secret values/);
    assert.match(saveCommand, /save --from .* --consume/);
    assert.match(saveCommand, /Do not connect the new context\s+automatically/);
    assert.match(createCommand, /fresh context/);
    assert.match(createCommand, /\/neatcontext:save/);
    assert.match(importCommand, /source bundle is read-only/);
  });

  it("advertises every command in the CLI help", async () => {
    assert.match(
      await cli("not-a-command"),
      /status \| list \| use \| create \| save \| import \| delete/
    );
  });

  it("rejects capture specs from an unknown schema version", async () => {
    const file = await writeCapture(validCapture({ schema: 99 }));
    assert.match(await cli("save", "--from", file), /Unsupported conversation capture schema/);
  });
});
