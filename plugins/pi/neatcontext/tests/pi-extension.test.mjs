// The registration layer, driven by a stand-in for pi's ExtensionAPI.
//
// pi is not a dependency of this package — it is the host that loads it — so
// there is no way to boot a real agent here. What can be checked is the shape of
// everything handed to pi: that the factory registers what it claims to, that
// the tool definitions carry the fields pi requires, and that the two handlers
// which decide what the model sees do the right thing with a session.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let home;
let api;
let extension;

// Just enough ExtensionAPI to record what the factory does with it.
function fakeApi() {
  return {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    messages: [],
    userMessages: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerTool(tool) {
      assert.ok(!this.tools.has(tool.name), `duplicate tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    },
    registerCommand(name, options) {
      assert.ok(!this.commands.has(name), `duplicate command ${name}`);
      this.commands.set(name, options);
    },
    sendMessage(message) {
      this.messages.push(message);
    },
    sendUserMessage(content) {
      this.userMessages.push(content);
    }
  };
}

// pi's ExtensionContext, narrowed to what this extension touches.
function fakeCtx(sessionId = "extension-test-session") {
  return {
    hasUI: false,
    mode: "print",
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId }
  };
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "neatcontext-pi-ext-"));
  process.env.NEATCONTEXT_COMPANION_FILE = path.join(home, "companion.json");
  extension = (await import("../extensions/neatcontext.js")).default;
  api = fakeApi();
  extension(api);
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("registration", () => {
  it("registers every tool the skills and prompts refer to", () => {
    assert.deepEqual(
      [...api.tools.keys()].sort(),
      [
        "describe_context",
        "get_context",
        "neatcontext_create",
        "neatcontext_save",
        "neatcontext_tool",
        "preview_context",
        "use_context"
      ]
    );
  });

  it("gives pi every field a ToolDefinition requires", () => {
    for (const [name, tool] of api.tools) {
      assert.equal(tool.name, name);
      assert.equal(typeof tool.label, "string", `${name} needs a label`);
      assert.ok(tool.description.length > 0, `${name} needs a description`);
      assert.equal(tool.parameters.type, "object", `${name} needs an object schema`);
      assert.equal(typeof tool.execute, "function");
      for (const required of tool.parameters.required ?? []) {
        assert.ok(
          Object.hasOwn(tool.parameters.properties, required),
          `${name} requires "${required}" but does not declare it`
        );
      }
    }
  });

  it("registers the commands, under pi's flat naming", () => {
    assert.deepEqual(
      [...api.commands.keys()].sort(),
      [
        "neatcontext-create",
        "neatcontext-delete",
        "neatcontext-disconnect",
        "neatcontext-import",
        "neatcontext-list",
        "neatcontext-mode",
        "neatcontext-save",
        "neatcontext-status",
        "neatcontext-use"
      ]
    );
    for (const [name, command] of api.commands) {
      assert.equal(typeof command.handler, "function", `${name} needs a handler`);
      assert.ok(command.description.length > 0, `${name} needs a description`);
    }
  });

  it("subscribes to the two events grounding depends on", () => {
    assert.deepEqual([...api.handlers.keys()].sort(), ["before_agent_start", "session_start"]);
  });
});

describe("grounding handlers", () => {
  it("appends its notes to pi's system prompt rather than replacing it", async () => {
    const result = await api.handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "PI SYSTEM PROMPT" },
      fakeCtx()
    );
    assert.match(result.systemPrompt, /^PI SYSTEM PROMPT/);
    assert.match(result.systemPrompt, /# NeatContext/);
    assert.match(result.systemPrompt, /## Connecting a context, in pi/);
  });

  it("binds the session id pi reports", async () => {
    const session = await import("../src/pi/session.mjs");
    await api.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx("bound-by-event"));
    assert.equal(session.piSessionId(), "bound-by-event");
  });

  it("survives a context that cannot answer, instead of failing the turn", async () => {
    const result = await api.handlers.get("before_agent_start")(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "PI SYSTEM PROMPT" },
      { hasUI: false, sessionManager: null }
    );
    assert.ok(result === undefined || typeof result.systemPrompt === "string");
  });
});

describe("commands", () => {
  it("reports command output into the session where the model can see it", async () => {
    api.messages.length = 0;
    await api.commands.get("neatcontext-status").handler("", fakeCtx());
    assert.equal(api.messages.length, 1);
    assert.equal(api.messages[0].customType, "neatcontext");
    assert.equal(api.messages[0].display, true);
    assert.match(api.messages[0].content, /No context is connected yet/);
  });

  it("hands the two model-authored workflows to the model", async () => {
    api.userMessages.length = 0;
    await api.commands.get("neatcontext-save").handler("Queue lag", fakeCtx());
    await api.commands.get("neatcontext-create").handler("", fakeCtx());
    assert.equal(api.userMessages.length, 2);
    assert.match(api.userMessages[0], /neatcontext-save` skill/);
    assert.match(api.userMessages[0], /Queue lag/);
    assert.match(api.userMessages[1], /neatcontext-create` skill/);
  });

  it("passes --lite through to the list command", async () => {
    api.messages.length = 0;
    await api.commands.get("neatcontext-list").handler("--lite", fakeCtx());
    assert.match(api.messages[0].content, /Lite contexts:/);
    assert.doesNotMatch(api.messages[0].content, /Standard contexts:/);
  });

  it("routes --global to the mode command without treating it as a mode", async () => {
    api.messages.length = 0;
    await api.commands.get("neatcontext-mode").handler("auto --global", fakeCtx());
    assert.match(api.messages[0].content, /now auto everywhere/);
    await api.commands.get("neatcontext-mode").handler("ask", fakeCtx());
  });

  it("does not delete without a confirmation it never got", async () => {
    api.messages.length = 0;
    await api.commands.get("neatcontext-delete").handler("nothing-by-that-name", fakeCtx());
    assert.match(api.messages[0].content, /No single lite context matched/);
  });
});
