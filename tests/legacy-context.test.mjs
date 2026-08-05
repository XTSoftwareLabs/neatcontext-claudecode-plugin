// End-to-end protection for contexts saved by earlier releases.
//
// Users upgrade with contexts already on disk, written in the schema this
// plugin shipped before the unified Context model. Those bundles are the one
// input this repository cannot regenerate: if a release stops reading them, the
// user's own work disappears from `/neatcontext:list` with nothing to point at.
// That is not hypothetical — a manifest written with the current schema while
// still carrying the legacy `kind: "lite"` marker matched neither shape the
// reader accepted, and updating any legacy context produced exactly that.
//
// The second constraint is that a machine can have several host plugins
// installed at different versions, all sharing ~/.neatcontext. A release
// predating the unified model reads only the legacy root and accepts a manifest
// only when the marker is present, without ever looking at the schema. So a
// legacy bundle must be read where it lies and keep its marker: relocating it,
// or writing it away, empties the list in every host not yet updated.
//
// So the fixtures here are hand-written, byte-for-byte as an older build left
// them, and everything runs through the real CLI and the real MCP bridge as
// spawned processes — the same path Claude Code drives. Nothing imports the
// store directly, because the question is whether the shipped commands work.
//
// Covered, per legacy shape:
//   * it is listed, connectable, and served by get_context
//   * updating it keeps it listed (the regression) and keeps the marker
//   * a bundle in the pre-unification root is read in place, never relocated
//   * updating such a bundle leaves it readable to an older release
//   * a bundle an older build already broke is readable again
//   * export/import round-trips it

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeSession } from "./process-helpers.mjs";

const claude = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-code",
  "neatcontext",
  "src",
  "claude"
);

let home;
let serial = 0;

const childEnv = (sessionId = "legacy-session") => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: sessionId,
  // A window of its own, so a host pointer from the ambient environment cannot
  // decide which session these children are on.
  NEATCONTEXT_HOST_KEY: `host-${sessionId}`,
  CLAUDE_PID: "",
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-legacy-test-"));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-hosts"), { recursive: true, force: true });
});

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(claude, "neatcontext-cli.mjs"), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv()
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
}

// The MCP server Claude Code launches, driven over real stdio JSON-RPC.
function openBridge() {
  const child = spawn(process.execPath, [path.join(claude, "mcp-bridge.mjs")], {
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
    async handshake() {
      const response = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1" }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      return response;
    },
    grounding: async () =>
      (await send("tools/call", { name: "get_context", arguments: {} })).result.content[0].text,
    close: () => closeSession(child)
  };
}

// A context bundle exactly as a pre-unification release wrote it: schema 1,
// `kind: "lite"`, and no fields the current writer adds.
async function writeLegacyBundle(
  name,
  { root = "contexts", folder = null, manifest: overrides = {} } = {}
) {
  const directory = path.join(home, root, folder ?? `${name.toLowerCase().replace(/\s+/g, "-")}`);
  await mkdir(path.join(directory, "knowledge"), { recursive: true });
  const manifest = {
    schema: 1,
    id: `lite:${folder ?? name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    kind: "lite",
    createdAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    knowledgeFolder: "knowledge",
    knowledgeManaged: true,
    capturedFrom: "claude-code-conversation",
    routingDescription: `questions about ${name}`,
    profileFile: "profile.md",
    ...overrides
  };
  await writeFile(
    path.join(directory, "context.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(directory, "profile.md"),
    `# ${name}\n\n## Purpose\nThe original ${name} profile.\n`,
    "utf8"
  );
  await writeFile(
    path.join(directory, "knowledge", "session-summary.md"),
    `# ${name} summary\n\nOriginal knowledge.\n`,
    "utf8"
  );
  return { directory, manifest };
}

const readManifest = async (directory) =>
  JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));

// An update capture aimed at an existing context, the way /neatcontext:save
// builds one. The base hash has to come from the CLI, which is what a real
// save does.
async function writeUpdateCapture(name, { profile, summary }) {
  const target = await cli("save-target", name);
  const targetId = /^Context id: (.+)$/m.exec(target)?.[1];
  const baseHash = /^Base hash: (.+)$/m.exec(target)?.[1];
  assert.ok(targetId, `save-target did not resolve an id for "${name}": ${target}`);
  assert.ok(baseHash, `save-target did not print a base hash for "${name}": ${target}`);
  const file = path.join(home, `capture-${serial++}.json`);
  await writeFile(
    file,
    JSON.stringify({
      schema: 1,
      name,
      targetId,
      baseHash,
      profile,
      routingDescription: `questions about ${name}, updated`,
      knowledge: [{ path: "session-summary.md", content: summary }]
    }),
    "utf8"
  );
  return file;
}

describe("a context saved by an earlier release", () => {
  it("is listed, connectable, and served to the session", async () => {
    await writeLegacyBundle("Payments Legacy");

    assert.match(await cli("list"), /Payments Legacy/);
    assert.match(await cli("use", "Payments Legacy"), /Connected the "Payments Legacy" context/);

    assert.match(await cli("status"), /Connected context: Payments Legacy/);

    const bridge = openBridge();
    try {
      await bridge.handshake();
      const grounding = await bridge.grounding();
      assert.match(grounding, /connected context: Payments Legacy/i);
      // The pointers it serves have to be the real ones, not just the name.
      assert.match(grounding, /profile\.md/);
      assert.match(grounding, /session-summary\.md/);
      // The routing description stored in the legacy manifest still routes,
      // without the context having to be re-described after the upgrade.
      assert.match(grounding, /questions about Payments Legacy/);
    } finally {
      await bridge.close();
    }
  });

  it("is still there after an update, and keeps the marker an older release needs", async () => {
    // The regression: writing the current schema over a legacy manifest used to
    // leave `kind: "lite"` behind, and the result matched no readable shape. The
    // bundle stayed on disk and the context vanished from every command.
    //
    // The marker itself is kept on purpose — a release that predates the
    // unified model shares this store and accepts a manifest only when it is
    // there. What had to change was reading, not writing.
    const { directory } = await writeLegacyBundle("Payments Legacy");
    await cli("use", "Payments Legacy");

    const capture = await writeUpdateCapture("Payments Legacy", {
      profile: "# Payments Legacy\n\n## Purpose\nThe updated profile.\n",
      summary: "# Payments Legacy summary\n\nUpdated knowledge.\n"
    });
    const saved = await cli("save", "--from", capture, "--yes");
    assert.match(saved, /Updated context: Payments Legacy/);
    // The crash this used to end in happened after the write, so a green
    // manifest is not enough — the command has to report success too.
    assert.doesNotMatch(saved, /NeatContext plugin error/);

    assert.match(await cli("list"), /Payments Legacy/);
    assert.match(await cli("status"), /Connected context: Payments Legacy/);

    const manifest = await readManifest(directory);
    assert.equal(manifest.schema, 2);
    assert.equal(
      manifest.kind,
      "lite",
      "the marker an older release reads by must survive the update"
    );
    assert.equal(manifest.revision, 2);
    assert.equal(manifest.id, "lite:payments-legacy", "the identifier must not change");

    const bridge = openBridge();
    try {
      await bridge.handshake();
      assert.match(await bridge.grounding(), /connected context: Payments Legacy/i);
    } finally {
      await bridge.close();
    }
    assert.match(
      await readFile(path.join(directory, "knowledge", "session-summary.md"), "utf8"),
      /Updated knowledge/
    );
  });

  it("is read where it lies in the pre-unification root, and is never relocated", async () => {
    // Older releases stored bundles under ~/.neatcontext/lite/ and read only
    // that root. Several host plugins share this machine and update at
    // different times, so moving a bundle out of it would make every context
    // vanish from every host still on such a release. It has to be read in
    // place instead.
    await writeLegacyBundle("Orders Legacy", { root: "lite", folder: "orders-legacy" });
    const original = path.join(home, "lite", "orders-legacy");

    assert.match(await cli("list"), /Orders Legacy/);
    assert.match(await cli("use", "Orders Legacy"), /Connected the "Orders Legacy" context/);

    const bridge = openBridge();
    try {
      await bridge.handshake();
      assert.match(await bridge.grounding(), /connected context: Orders Legacy/i);
    } finally {
      await bridge.close();
    }

    // Still where the older release put it, still in the shape it wrote.
    assert.ok(
      await stat(original).then(() => true).catch(() => false),
      "the bundle must not be moved out of the legacy root"
    );
    const manifest = await readManifest(original);
    assert.equal(manifest.kind, "lite");
    assert.ok(
      await stat(path.join(home, "contexts", "orders-legacy"))
        .then(() => false)
        .catch(() => true),
      "nothing may be copied into the neutral root either"
    );
  });

  it("is updated in place in the legacy root, staying readable to an older release", async () => {
    // The full mixed-version round trip: a bundle an older release created,
    // updated by this one, has to stay where it was, keep its marker, and carry
    // the new content.
    await writeLegacyBundle("Refunds Legacy", { root: "lite", folder: "refunds-legacy" });
    const directory = path.join(home, "lite", "refunds-legacy");

    const capture = await writeUpdateCapture("Refunds Legacy", {
      profile: "# Refunds Legacy\n\n## Purpose\nUpdated from the unified plugin.\n",
      summary: "# Refunds Legacy summary\n\nUpdated from the unified plugin.\n"
    });
    const saved = await cli("save", "--from", capture, "--yes");
    assert.match(saved, /Updated context: Refunds Legacy/);
    assert.doesNotMatch(saved, /NeatContext plugin error/);

    const manifest = await readManifest(directory);
    assert.equal(manifest.kind, "lite", "an older release must still accept it");
    assert.equal(manifest.revision, 2);
    assert.match(
      await readFile(path.join(directory, "profile.md"), "utf8"),
      /Updated from the unified plugin/
    );
    assert.match(await cli("list"), /Refunds Legacy/);
  });

  it("is readable again when an older build already broke its manifest", async () => {
    // What the bug left behind: the current schema plus the legacy marker. The
    // bundle is intact, so the fix has to recover it rather than require the
    // user to repair a JSON file by hand.
    const { directory } = await writeLegacyBundle("Stranded Legacy", {
      manifest: { schema: 2, kind: "lite" }
    });

    assert.match(await cli("list"), /Stranded Legacy/);
    assert.match(await cli("use", "Stranded Legacy"), /Connected the "Stranded Legacy" context/);

    const bridge = openBridge();
    try {
      await bridge.handshake();
      assert.match(await bridge.grounding(), /connected context: Stranded Legacy/i);
    } finally {
      await bridge.close();
    }

    // And it stays recovered across an update, rather than lapsing back.
    const capture = await writeUpdateCapture("Stranded Legacy", {
      profile: "# Stranded Legacy\n\n## Purpose\nRecovered and updated.\n",
      summary: "# Stranded Legacy summary\n\nRecovered.\n"
    });
    assert.match(await cli("save", "--from", capture, "--yes"), /Updated context: Stranded Legacy/);
    assert.equal((await readManifest(directory)).revision, 2);
    assert.match(await cli("list"), /Stranded Legacy/);
  });

  it("round-trips through export and import", async () => {
    await writeLegacyBundle("Shareable Legacy");
    const destination = path.join(home, "exported");

    const exported = await cli("export", "Shareable Legacy", "--to", destination);
    assert.doesNotMatch(exported, /NeatContext plugin error/);
    const bundle = /^(?:Context folder|Exported to):\s+(.+)$/m.exec(exported)?.[1]
      ?? path.join(destination, "shareable-legacy");
    const exportedManifest = await readManifest(bundle);
    assert.equal(exportedManifest.schema, 2);
    assert.equal(exportedManifest.kind, undefined, "an exported bundle must not carry the marker");

    const imported = await cli("import", "--from", bundle, "--name", "Imported Legacy");
    assert.match(imported, /Imported Legacy/);
    assert.match(await cli("list"), /Imported Legacy/);
  });
});
