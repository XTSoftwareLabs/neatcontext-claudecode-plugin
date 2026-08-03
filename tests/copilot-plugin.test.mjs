// The GitHub Copilot plugin is a thin fork of the claude-code plugin: hooks
// and src/core reused verbatim, commands ported, and a lite-only host adapter
// in src/copilot. These tests pin the fork's three contracts: what must stay
// byte-identical to claude-code, what must never leave the machine (no
// companion HTTP), and how sessions scope to workspaces on hosts that expose
// no session identity.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeSession, startFakeCompanion } from "./fake-companion.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const claudeRoot = path.join(repositoryRoot, "plugins", "claude-code", "neatcontext");
const pluginRoot = path.join(repositoryRoot, "plugins", "copilot", "neatcontext");
const cli = path.join(pluginRoot, "src", "copilot", "neatcontext-cli.mjs");
const bridge = path.join(pluginRoot, "src", "copilot", "mcp-bridge.mjs");
const commandNames = [
  "create",
  "delete",
  "disconnect",
  "export",
  "import",
  "list",
  "mode",
  "save",
  "status",
  "use"
];
const USER_ONLY_COMMANDS = [
  "create",
  "delete",
  "disconnect",
  "export",
  "import",
  "mode",
  "save",
  "use"
];

function parseFrontmatter(markdown, file) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  assert.ok(normalized.startsWith("---\n"), `${file} must start with YAML frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  assert.notEqual(end, -1, `${file} must close its YAML frontmatter`);
  return Object.fromEntries(
    normalized
      .slice(4, end)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        assert.notEqual(separator, -1, `${file} has invalid frontmatter: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );
}

function runNode(script, args = [], { env = {}, cwd = pluginRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rpcSession(env, { cwd = pluginRoot } = {}) {
  const child = spawn(process.execPath, [bridge], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue; // notification, including tools/list_changed
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.once("error", (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });
  child.once("close", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`Copilot MCP bridge exited with ${code}. stderr: ${stderr || "(empty)"}`)
      );
    }
    pending.clear();
  });

  return {
    child,
    call(message) {
      assert.notEqual(message.id, undefined, "RPC test calls require an id");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new Error(`Timed out waiting for RPC response ${message.id}. stderr: ${stderr}`));
        }, 10000);
        timer.unref?.();
        pending.set(message.id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    async close() {
      await closeSession(child);
      assert.equal(stderr, "");
    }
  };
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "copilot-plugin-test", version: "1" }
    }
  };
}

function toolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  };
}

// One isolated NeatContext home per test: lite store, selections, and routing
// state all root at the discovery file's directory.
async function isolatedHome(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    directory,
    env: { NEATCONTEXT_COMPANION_FILE: path.join(directory, "companion.json") }
  };
}

async function knowledgeFolder(home, files = { "runbook.md": "# Runbook\n" }) {
  const folder = path.join(home.directory, "knowledge");
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(folder, name), content, "utf8");
  }
  return folder;
}

async function createLiteContext(home, name, { sessionId = "copilot-test" } = {}) {
  const folder = await knowledgeFolder(home);
  const profileFile = path.join(home.directory, `${name.replace(/\W+/g, "-")}-profile.md`);
  await writeFile(
    profileFile,
    `# ${name}\n\n## Purpose\n\nTesting the Copilot plugin.\n`,
    "utf8"
  );
  const result = await runNode(
    cli,
    [
      "create",
      "--name",
      name,
      "--knowledge",
      folder,
      "--profile-from",
      profileFile,
      "--use-when",
      `Questions about ${name}`
    ],
    { env: { ...home.env, NEATCONTEXT_SESSION_ID: sessionId } }
  );
  assert.match(result.stdout, new RegExp(`Created the "${name}" lite context`));
  return result;
}

test("Copilot plugin manifest is complete, version-aligned, and listed in the marketplace", async () => {
  const [pluginText, marketplaceText, packageText, bridgeText, readme, copilotReadme] =
    await Promise.all([
      readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
      readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(bridge, "utf8"),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(pluginRoot, "README.md"), "utf8")
    ]);
  const plugin = JSON.parse(pluginText);
  const marketplace = JSON.parse(marketplaceText);
  const packageJson = JSON.parse(packageText);

  assert.equal(plugin.name, "neatcontext");
  assert.equal(plugin.displayName, "NeatContext");
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.license, "MIT");
  assert.equal(plugin.hooks, "./hooks/hooks.json");
  assert.match(
    bridgeText,
    new RegExp(
      `SERVER_INFO = \\{ name: "neatcontext", version: "${plugin.version.replaceAll(".", "\\.")}" \\}`
    )
  );

  const server = plugin.mcpServers.neatcontext;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/copilot/mcp-bridge.mjs"]);
  const prefix = "${CLAUDE_PLUGIN_ROOT}/";
  assert.ok((await stat(path.join(pluginRoot, server.args[0].slice(prefix.length)))).isFile());
  assert.ok((await stat(path.join(pluginRoot, plugin.hooks.slice(2)))).isFile());

  const entry = marketplace.plugins.find((candidate) => candidate.name === "neatcontext-copilot");
  assert.ok(entry, "marketplace.json must carry the copilot plugin entry");
  assert.equal(entry.source.source, "git-subdir");
  assert.equal(entry.source.path, "plugins/copilot/neatcontext");
  assert.equal(entry.repository, "https://github.com/XTSoftwareLabs/neatcontext-plugins");

  // Copilot CLI rejects the Claude marketplace's git-subdir sources outright
  // (verified against copilot 1.0.59), so Copilot installs go through this
  // second, Copilot-format index. Its only supported source is a relative
  // path, which must keep pointing at the same plugin directory.
  const copilotMarketplace = JSON.parse(
    await readFile(path.join(repositoryRoot, ".github", "plugin", "marketplace.json"), "utf8")
  );
  assert.equal(copilotMarketplace.name, "neatcontext");
  const copilotEntry = copilotMarketplace.plugins.find(
    (candidate) => candidate.name === "neatcontext-copilot"
  );
  assert.ok(copilotEntry, ".github/plugin/marketplace.json must list the copilot plugin");
  assert.equal(copilotEntry.version, packageJson.version);
  assert.equal(copilotEntry.source, "./plugins/copilot/neatcontext");
  assert.ok(
    (await stat(path.join(repositoryRoot, copilotEntry.source))).isDirectory(),
    "the copilot marketplace source path must resolve"
  );

  assert.match(
    readme,
    /\[NeatContext for GitHub Copilot\]\(plugins\/copilot\/neatcontext\/README\.md\)/
  );
  assert.match(
    copilotReadme,
    /copilot plugin install XTSoftwareLabs\/neatcontext-plugins:plugins\/copilot\/neatcontext/
  );
  assert.match(copilotReadme, /chat\.plugins\.enabled/);
  assert.match(copilotReadme, /\[Privacy Policy\]\(\.\.\/\.\.\/\.\.\/PRIVACY\.md\)/);
});

// The hooks' fail-silent design is what makes shipping them on Copilot safe at
// all, and src/core is a synced copy by repo convention. Any divergence is a
// fork starting to drift; it has to be deliberate, and it has to show up here.
test("Copilot plugin reuses the claude-code hooks and core verbatim", async () => {
  const verbatim = [
    ["hooks", "hooks.json"],
    ["hooks", "stop.mjs"],
    ["hooks", "pre-compact.mjs"],
    ...(await readdir(path.join(claudeRoot, "src", "core"))).map((name) => ["src", "core", name])
  ];
  for (const parts of verbatim) {
    const [ours, theirs] = await Promise.all([
      readFile(path.join(pluginRoot, ...parts), "utf8"),
      readFile(path.join(claudeRoot, ...parts), "utf8")
    ]);
    assert.equal(ours, theirs, `${parts.join("/")} must be byte-identical to claude-code's`);
  }
});

test("Copilot commands are complete, lite-only, and pre-approve only the bundled CLI", async () => {
  const actual = (await readdir(path.join(pluginRoot, "commands")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(actual, commandNames);

  for (const name of commandNames) {
    const file = path.join(pluginRoot, "commands", `${name}.md`);
    const markdown = await readFile(file, "utf8");
    const frontmatter = parseFrontmatter(markdown, file);

    assert.ok(frontmatter.description, `${file} must carry a description`);
    assert.ok(
      frontmatter["allowed-tools"]?.includes(
        'Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)'
      ),
      `${file} must limit its Node.js grant to the bundled CLI`
    );
    assert.doesNotMatch(
      frontmatter["allowed-tools"],
      /Bash\(node:\*\)/,
      `${file} must not grant arbitrary Node.js execution`
    );
    assert.doesNotMatch(
      markdown,
      /!`[^\r\n`]*\$ARGUMENTS/,
      `${file} must not substitute user arguments into a preprocessing shell command`
    );
    // A ported command still pointing at the claude adapter would run against
    // the wrong session scoping; one still using Claude env expansions would
    // write to a literal "${CLAUDE_PROJECT_DIR}" path on Copilot hosts.
    assert.doesNotMatch(markdown, /src\/claude\//, `${file} must call the copilot adapter`);
    assert.doesNotMatch(
      markdown,
      /CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID/,
      `${file} must not rely on Claude Code env expansions`
    );
    // Lite-only: no command may send the user to the desktop app or promise
    // standard contexts this plugin cannot serve.
    assert.doesNotMatch(markdown, /desktop app/i, `${file} must not reference the desktop app`);
    assert.doesNotMatch(
      markdown,
      /standard context/i,
      `${file} must not promise standard contexts`
    );
  }

  for (const name of USER_ONLY_COMMANDS) {
    const file = path.join(pluginRoot, "commands", `${name}.md`);
    const frontmatter = parseFrontmatter(await readFile(file, "utf8"), file);
    assert.equal(
      frontmatter["disable-model-invocation"],
      "true",
      `${file} must set disable-model-invocation: true`
    );
  }
});

test("Copilot CLI serves lite contexts without ever contacting the companion", async (t) => {
  // A live companion with contexts to offer is the strongest temptation the
  // lite-only variant can face; the assertion is that it never even knocks.
  const companion = await startFakeCompanion();
  t.after(() => companion.stop());
  const home = { directory: companion.directory, env: { NEATCONTEXT_COMPANION_FILE: companion.discoveryFile } };
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-cli-a" };

  await createLiteContext(home, "copilot docs", { sessionId: "copilot-cli-a" });

  const list = await runNode(cli, ["list"], { env });
  assert.match(list.stdout, /Lite contexts:/);
  assert.match(list.stdout, /copilot docs/);
  assert.doesNotMatch(list.stdout, /Standard contexts:/);
  assert.doesNotMatch(list.stdout, /payment team/);

  const use = await runNode(cli, ["use", "copilot docs"], { env });
  assert.match(use.stdout, /Connected the "copilot docs" lite context/);

  const status = await runNode(cli, ["status"], { env });
  assert.match(status.stdout, /Connected context: copilot docs \(lite\)/);
  assert.match(status.stdout, /Context routing: ask/);

  const saveTarget = await runNode(cli, ["save-target"], { env });
  assert.match(saveTarget.stdout, /Save action: update/);
  assert.match(saveTarget.stdout, /Context name: copilot docs/);

  const disconnect = await runNode(cli, ["disconnect"], { env });
  assert.match(disconnect.stdout, /Disconnected the "copilot docs" context/);

  const other = await runNode(cli, ["status"], {
    env: { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-cli-b" }
  });
  assert.match(other.stdout, /No context is connected yet/);

  assert.equal(companion.state.sessionHeaders.length, 0, "no authorized companion request");
  assert.equal(companion.state.puts, 0, "no companion connection attempt");
});

test("Copilot sessions scope to the workspace when no session id is provided", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-ws-");
  const workspaceA = await mkdtemp(path.join(os.tmpdir(), "copilot-ws-a-"));
  const workspaceB = await mkdtemp(path.join(os.tmpdir(), "copilot-ws-b-"));
  // An empty override is "not set": the runs below must fall through to the
  // workspace digest even when the test runner's own environment carries ids.
  const wsEnv = { ...home.env, NEATCONTEXT_SESSION_ID: "" };

  await createLiteContext(home, "workspace scoped");

  const connect = await runNode(cli, ["use", "workspace scoped"], {
    env: wsEnv,
    cwd: workspaceA
  });
  assert.match(connect.stdout, /Connected the "workspace scoped" lite context/);

  // Same workspace, new process: the selection must be found again — this is
  // the CLI-to-MCP-server agreement the workspace digest exists for.
  const sameWorkspace = await runNode(cli, ["status"], { env: wsEnv, cwd: workspaceA });
  assert.match(sameWorkspace.stdout, /Connected context: workspace scoped \(lite\)/);

  const otherWorkspace = await runNode(cli, ["status"], { env: wsEnv, cwd: workspaceB });
  assert.match(otherWorkspace.stdout, /No context is connected yet/);

  const modeA = await runNode(cli, ["mode", "auto"], { env: wsEnv, cwd: workspaceA });
  assert.match(modeA.stdout, /now auto for this session/);
  const modeB = await runNode(cli, ["mode"], { env: wsEnv, cwd: workspaceB });
  assert.match(modeB.stdout, /ask \(the default\)/);
});

test("Copilot MCP bridge serves lite contexts and routing locally", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-mcp-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-mcp-a" };

  await createLiteContext(home, "bridge target", { sessionId: "copilot-mcp-a" });

  const session = rpcSession(env);
  sessions.push(session);

  const initialized = await session.call(initialize(1));
  assert.equal(initialized.result.serverInfo.name, "neatcontext");
  assert.match(initialized.result.instructions, /get_context/);
  assert.match(initialized.result.instructions, /Connecting a context, in GitHub Copilot/);
  assert.doesNotMatch(initialized.result.instructions, /desktop app is installed/);

  const tools = await session.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    ["get_context", "preview_context", "use_context"]
  );

  const empty = await session.call(toolCall(3, "get_context"));
  assert.equal(empty.result.isError, false);
  assert.match(empty.result.content[0].text, /No NeatContext Context is connected/);

  // Ask mode is the default: the switch must be refused until requested.
  const refused = await session.call(
    toolCall(4, "use_context", { context: "bridge target", reason: "test" })
  );
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /ask mode/);

  const preview = await session.call(toolCall(5, "preview_context", { context: "bridge target" }));
  assert.equal(preview.result.isError, false);
  assert.match(preview.result.content[0].text, /bridge target \(lite\)/);
  assert.match(preview.result.content[0].text, /runbook\.md/);

  const switched = await session.call(
    toolCall(6, "use_context", { context: "bridge target", requested: true })
  );
  assert.equal(switched.result.isError, false);
  assert.match(switched.result.content[0].text, /Switched this session to "bridge target"/);

  const grounded = await session.call(toolCall(7, "get_context"));
  assert.equal(grounded.result.isError, false);
  assert.match(grounded.result.content[0].text, /bridge target/);
  assert.match(grounded.result.content[0].text, /profile\.md/);

  const prompts = await session.call({
    jsonrpc: "2.0",
    id: 8,
    method: "prompts/list",
    params: {}
  });
  assert.deepEqual(prompts.result.prompts, []);

  const unknown = await session.call(toolCall(9, "demo_ctx_payments"));
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /lite contexts only/);
});

test("Copilot MCP bridge hides the routing tools in manual mode", async (t) => {
  const home = await isolatedHome("neatcontext-copilot-manual-");
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  const env = { ...home.env, NEATCONTEXT_SESSION_ID: "copilot-manual-a" };

  const mode = await runNode(cli, ["mode", "manual"], { env });
  assert.match(mode.stdout, /now manual for this session/);

  const session = rpcSession(env);
  sessions.push(session);
  await session.call(initialize(1));
  const tools = await session.call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["get_context"]);
});

// The nudge hooks ship verbatim, so all that is left to verify on the Copilot
// layout is the reuse contract itself: whatever a host feeds them, they exit 0
// with no output rather than break stopping or compaction.
test("Copilot hooks stay silent on hostile or absent host contracts", async () => {
  const stopHook = path.join(pluginRoot, "hooks", "stop.mjs");
  const preCompactHook = path.join(pluginRoot, "hooks", "pre-compact.mjs");
  const home = await isolatedHome("neatcontext-copilot-hooks-");

  const cases = [
    ["", "empty stdin"],
    ["not json", "non-JSON stdin"],
    ["{}", "no session_id"],
    [JSON.stringify({ session_id: "copilot-hook-a" }), "no transcript_path"]
  ];
  for (const hook of [stopHook, preCompactHook]) {
    for (const [input, label] of cases) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hook], {
          cwd: pluginRoot,
          env: { ...process.env, ...home.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
      assert.equal(result.code, 0, `${path.basename(hook)} must exit 0 on ${label}`);
      assert.equal(result.stdout, "", `${path.basename(hook)} must stay silent on ${label}`);
      assert.equal(result.stderr, "", `${path.basename(hook)} must not warn on ${label}`);
    }
  }
});
