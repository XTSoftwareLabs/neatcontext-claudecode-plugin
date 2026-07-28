import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const marketplaceRoot = path.resolve(here, "..");
const pluginRoot = path.join(marketplaceRoot, "plugins", "neatcontext");
const cli = path.join(pluginRoot, "src", "codex", "neatcontext-cli.mjs");
const bridge = path.join(pluginRoot, "src", "codex", "mcp-bridge.mjs");
const hook = path.join(pluginRoot, "hooks", "session-start.mjs");

function runNode(script, args = [], { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: marketplaceRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function rpcSession(env) {
  const child = spawn(process.execPath, [bridge], {
    cwd: pluginRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  const waiting = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n") && waiting.length > 0) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      waiting.shift().resolve(JSON.parse(line));
    }
  });
  function call(message) {
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  return {
    call,
    close() {
      child.stdin.end();
      child.kill();
    }
  };
}

test("marketplace and plugin manifests describe an isolated Codex package", async () => {
  const marketplace = JSON.parse(
    await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")
  );
  assert.equal(marketplace.plugins[0].source.path, "./plugins/neatcontext");
  assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");

  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "neatcontext");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");

  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.neatcontext.args, ["./src/codex/mcp-bridge.mjs"]);
  assert.equal(mcp.mcpServers.neatcontext.cwd, ".");
});

test("all namespaced workflows are real skills without scaffold placeholders", async () => {
  const expected = ["create", "delete", "import", "list", "mode", "save", "status", "use"];
  const actual = (await readdir(path.join(pluginRoot, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, expected);

  for (const name of expected) {
    const skill = await readFile(path.join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, "m"));
    assert.doesNotMatch(skill, /\[TODO|TODO:/);
  }
});

test("Codex CLI isolates routing by CODEX_THREAD_ID", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-routing-"));
  const env = {
    NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json"),
    CODEX_THREAD_ID: "thread-a"
  };

  const changed = await runNode(cli, ["mode", "auto"], { env });
  assert.equal(changed.code, 0);
  assert.match(changed.stdout, /Other Codex threads keep theirs/);

  const current = await runNode(cli, ["mode"], { env });
  assert.match(current.stdout, /Context routing is auto \(this session\)/);

  const other = await runNode(cli, ["mode"], {
    env: { ...env, CODEX_THREAD_ID: "thread-b" }
  });
  assert.match(other.stdout, /Context routing is ask \(the default\)/);
});

test("Codex saves conversation provenance without touching a transcript", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-save-"));
  const capturePath = path.join(home, "capture.json");
  await writeFile(
    capturePath,
    JSON.stringify({
      schema: 1,
      name: "Codex smoke context",
      profile:
        "# Codex smoke context\n\n## Purpose\nTest Codex capture.\n\n## What to do\nUse the saved facts.\n\n## What to avoid\nDo not invent facts.\n\n## Behavior\nBe concise.",
      routingDescription: "Use for Codex plugin smoke-test requests.",
      knowledge: [
        {
          path: "session-summary.md",
          content: "# Session summary\n\nThe Codex capture path works."
        }
      ]
    }),
    "utf8"
  );

  const result = await runNode(cli, ["save", "--from", capturePath, "--consume"], {
    env: {
      NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json"),
      CODEX_THREAD_ID: "save-thread"
    }
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Use command: \$neatcontext:use Codex smoke context/);

  const liteEntries = await readdir(path.join(home, "lite"));
  assert.equal(liteEntries.length, 1);
  const manifest = JSON.parse(
    await readFile(path.join(home, "lite", liteEntries[0], "context.json"), "utf8")
  );
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.capturedFrom, "codex-conversation");
});

test("SessionStart hook emits thread-scoped routing guidance", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-hook-"));
  const result = await runNode(hook, [], {
    env: {
      NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json"),
      CODEX_THREAD_ID: ""
    },
    input: JSON.stringify({
      session_id: "hook-thread",
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: marketplaceRoot
    })
  });
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /NeatContext is installed/);
  assert.match(output.hookSpecificOutput.additionalContext, /\$neatcontext:save/);
});

test("MCP bridge initializes offline and advertises grounding and routing tools", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-codex-mcp-"));
  const rpc = rpcSession({
    NEATCONTEXT_COMPANION_FILE: path.join(home, "companion.json"),
    CODEX_THREAD_ID: "mcp-thread"
  });
  try {
    const initialized = await rpc.call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test" } }
    });
    assert.equal(initialized.result.serverInfo.name, "neatcontext");
    assert.equal(initialized.result.capabilities.tools.listChanged, true);

    const listed = await rpc.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["get_context", "preview_context", "use_context"]);
    assert.equal(
      listed.result.tools.find((tool) => tool.name === "get_context").annotations.readOnlyHint,
      true
    );
  } finally {
    rpc.close();
  }
});
