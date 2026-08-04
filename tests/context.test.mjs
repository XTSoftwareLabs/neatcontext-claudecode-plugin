import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

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
const bridgeFile = path.join(
  root,
  "plugins",
  "claude-code",
  "neatcontext",
  "src",
  "claude",
  "mcp-bridge.mjs"
);
const store = await import(
  "../plugins/claude-code/neatcontext/src/core/context-store.mjs"
);

let home;
let docs;

const env = () => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: "context-test",
  NEATCONTEXT_HOME: home
});

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-context-test-"));
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "lite"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-selection.json"), { force: true });
  await rm(path.join(home, "plugin-sessions"), { recursive: true, force: true });
  await rm(path.join(home, "plugin-routing.json"), { force: true });
});

function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", () => resolve(`${stdout}${stderr}`.trim()));
  });
}

async function create(name = "Payments Runbooks") {
  return cli(
    "create",
    "--name",
    name,
    "--knowledge",
    docs,
    "--profile",
    `# ${name}\n\n## Purpose\nPayment operations.`
  );
}

function openBridge() {
  const child = spawn(process.execPath, [bridgeFile], {
    env: env(),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  const queued = [];
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  let id = 0;
  const next = () =>
    queued.length > 0
      ? Promise.resolve(queued.shift())
      : new Promise((resolve) => waiting.push(resolve));
  const send = async (method, params = {}) => {
    id += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return next();
  };
  return {
    send,
    close: async () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    }
  };
}

describe("local Context storage", () => {
  it("creates a schema 2 Context in the neutral directory", async () => {
    assert.match(await create(), /Created the "Payments Runbooks" context/);
    const directories = await readdir(path.join(home, "contexts"));
    assert.equal(directories.length, 1);
    const manifest = JSON.parse(
      await readFile(path.join(home, "contexts", directories[0], "context.json"), "utf8")
    );
    assert.equal(manifest.schema, 2);
    assert.match(manifest.id, /^context:/);
    assert.equal(manifest.kind, undefined);
    assert.equal(manifest.name, "Payments Runbooks");
    assert.equal(manifest.profileFile, "profile.md");
  });

  it("lists, connects, reports, and deletes the same Context type", async () => {
    await create();
    assert.match(await cli("list"), /Contexts:\s+1\. Payments Runbooks/);
    assert.match(await cli("use", "Payments"), /Connected the "Payments Runbooks" context/);
    const status = await cli("status");
    assert.match(status, /Connected context: Payments Runbooks/);
    assert.match(status, /Knowledge folder: .*docs \(1 files\)/);
    assert.doesNotMatch(status, /\(lite\)|\(standard\)/i);
    assert.match(await cli("delete", "Payments"), /Re-run with --yes to confirm/);
    assert.match(await cli("delete", "Payments", "--yes"), /Deleted the "Payments Runbooks" context/);
    assert.equal(await readFile(path.join(docs, "runbook.md"), "utf8"), "# Restart the worker\n");
  });

  it("refuses invalid input without leaving a partial Context", async () => {
    await assert.rejects(
      store.createContext({ name: "No knowledge", knowledgeFolder: "", profile: "# Empty" }),
      /knowledge folder is required/
    );
    assert.match(
      await cli("create", "--name", "Broken", "--knowledge", path.join(home, "missing"), "--profile", "# Broken"),
      /No folder at/
    );
    const malformed = path.join(home, "contexts", "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(path.join(malformed, "context.json"), "not json\n");
    assert.match(await cli("list"), /Contexts:\s+\(none/);
  });

  it("reports a Context deleted outside the plugin and can disconnect it", async () => {
    await create();
    await cli("use", "Payments");
    const [directory] = await readdir(path.join(home, "contexts"));
    await rm(path.join(home, "contexts", directory), { recursive: true, force: true });
    assert.match(await cli("status"), /is connected but is no longer on disk/);
    assert.match(await cli("disconnect"), /Disconnected the "Payments Runbooks" context/);
  });

  it("reports auto mode and refuses ambiguous save and delete targets", async () => {
    assert.match(await cli("mode", "auto"), /Other sessions keep theirs/);
    for (const suffix of ["a", "b"]) {
      const directory = path.join(home, "contexts", suffix);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "profile.md"), "# Duplicate\n");
      await writeFile(
        path.join(directory, "context.json"),
        `${JSON.stringify({
          schema: 2,
          id: `context:duplicate-${suffix}`,
          name: "Duplicate",
          profileFile: "profile.md",
          knowledgeFolder: docs
        })}\n`
      );
    }
    assert.match(await cli("save-target", "Duplicate"), /More than one context is named/);
    assert.match(await cli("delete"), /Which context should I delete/);
    assert.match(await cli("delete", "Duplicate"), /No single context matched/);
  });
});

describe("legacy migration", () => {
  it("moves a schema 1 folder and upgrades its manifest", async () => {
    const directory = path.join(home, "lite", "legacy-context");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "profile.md"), "# Legacy\n\n## Purpose\nOld data.\n");
    await writeFile(
      path.join(directory, "context.json"),
      `${JSON.stringify({
        schema: 1,
        kind: "lite",
        id: "lite:legacy-context",
        name: "Legacy",
        profileFile: "profile.md",
        knowledgeFolder: docs,
        knowledgeManaged: false
      }, null, 2)}\n`
    );

    assert.match(await cli("list"), /Legacy/);
    const migrated = path.join(home, "contexts", "legacy-context");
    const manifest = JSON.parse(await readFile(path.join(migrated, "context.json"), "utf8"));
    assert.equal(manifest.schema, 2);
    assert.equal("kind" in manifest, false);
    assert.equal(manifest.profileFile, "profile.md");
    await mkdir(path.join(home, "plugin-sessions"), { recursive: true });
    await writeFile(
      path.join(home, "plugin-sessions", "context-test.json"),
      `${JSON.stringify({ kind: "lite", contextId: "lite:legacy-context", contextName: "Legacy" })}\n`
    );
    assert.match(await cli("status"), /Connected context: Legacy/);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(home, "plugin-sessions", "context-test.json"), "utf8")
      ),
      { schema: 2, contextId: "lite:legacy-context", contextName: "Legacy" }
    );
  });

  it("resumes safely when a destination directory already exists", async () => {
    const legacy = path.join(home, "lite", "collision");
    const current = path.join(home, "contexts", "collision");
    await mkdir(legacy, { recursive: true });
    await mkdir(current, { recursive: true });
    await writeFile(path.join(legacy, "profile.md"), "# Legacy copy\n");
    await writeFile(path.join(current, "profile.md"), "# Current copy\n");
    await writeFile(
      path.join(legacy, "context.json"),
      `${JSON.stringify({
        schema: 1,
        kind: "lite",
        id: "lite:collision",
        name: "Legacy copy",
        knowledgeFolder: docs
      })}\n`
    );
    await writeFile(
      path.join(current, "context.json"),
      `${JSON.stringify({
        schema: 2,
        id: "lite:collision",
        name: "Current copy",
        knowledgeFolder: docs
      })}\n`
    );

    const listed = await cli("list");
    assert.match(listed, /Current copy/);
    assert.doesNotMatch(listed, /Legacy copy/);
    assert.equal(await readFile(path.join(legacy, "profile.md"), "utf8"), "# Legacy copy\n");
    assert.equal(await readFile(path.join(current, "profile.md"), "utf8"), "# Current copy\n");
  });

  it("reports and clears an unavailable legacy selection", async () => {
    const selectionFile = path.join(home, "plugin-sessions", "context-test.json");
    await mkdir(path.dirname(selectionFile), { recursive: true });
    await writeFile(
      selectionFile,
      `${JSON.stringify({ contextId: "unavailable:old", contextName: "Old selection" })}\n`
    );

    assert.match(await cli("status"), /Old selection.*not available/s);
    assert.match(await cli("status"), /No context is connected/);
    await assert.rejects(readFile(selectionFile, "utf8"), { code: "ENOENT" });
  });
});

describe("local MCP surface", () => {
  it("answers safely when no Context is selected", async () => {
    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const empty = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      assert.match(empty.result.content[0].text, /No NeatContext Context is connected/);
      const unknown = await bridge.send("tools/call", { name: "unknown", arguments: {} });
      assert.match(unknown.error.message, /serve only get_context/);
    } finally {
      await bridge.close();
    }
  });

  it("reports a selected Context removed outside the plugin", async () => {
    await create();
    await cli("use", "Payments");
    const [directory] = await readdir(path.join(home, "contexts"));
    await rm(path.join(home, "contexts", directory), { recursive: true, force: true });
    const bridge = openBridge();
    try {
      await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      const response = await bridge.send("tools/call", {
        name: "get_context",
        arguments: {}
      });
      assert.match(response.result.content[0].text, /no longer exists on disk/);
    } finally {
      await bridge.close();
    }
  });

  it("serves get_context and no provider-specific tools", async () => {
    await create();
    await cli("use", "Payments");
    const bridge = openBridge();
    try {
      const initialized = await bridge.send("initialize", { protocolVersion: "2025-11-25" });
      assert.match(initialized.result.instructions, /NeatContext Context/);
      const listed = await bridge.send("tools/list");
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes("get_context"));
      assert.doesNotMatch(names.join(" "), /lite|standard|extension/i);
      const response = await bridge.send("tools/call", { name: "get_context", arguments: {} });
      const text = response.result.content[0].text;
      assert.match(text, /connected context: Payments Runbooks/);
      assert.match(text, /profile\.md/);
      assert.match(text, /runbook\.md/);
    } finally {
      await bridge.close();
    }
  });
});
