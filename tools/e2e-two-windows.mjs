// E2E: two Claude Code windows, one machine, the real NeatContext desktop app.
//
// Each "window" is what Claude Code actually runs: one long-lived MCP bridge
// process, plus slash commands spawned as separate processes. Nothing is faked
// except the host itself.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

const PLUGIN = "C:/Workspace/neatcontextclaudecodeplugin";
const HOME = path.join(os.homedir(), ".neatcontext");
const DISCOVERY = path.join(HOME, "companion.json");
const SELECTION = path.join(HOME, "plugin-selection.json");

const { port, token } = JSON.parse(await readFile(DISCOVERY, "utf8"));

const api = async (method, route, { body, session } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(session ? { "x-neatcontext-session": session } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
};

// A window: one bridge process kept alive, exactly as Claude Code keeps it.
function openWindow(sessionId) {
  const child = spawn(process.execPath, [`${PLUGIN}/src/claude/mcp-bridge.mjs`], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId }
  });
  const waiters = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id != null && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiters.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  return {
    async start() {
      await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    // What this window would actually ground an answer in.
    async grounding() {
      const response = await send("tools/call", { name: "get_context", arguments: {} });
      const text = response.result?.content?.[0]?.text ?? "";
      const named = /connected context: ([^\n*]+)/i.exec(text) ?? /Context \*\*([^*]+)\*\*/.exec(text);
      return named ? named[1].trim() : "NONE";
    },
    async tools() {
      const response = await send("tools/list");
      return (response.result?.tools ?? [])
        .map((tool) => tool.name)
        .filter((name) => !["get_context", "use_context", "preview_context"].includes(name));
    },
    close: () => new Promise((r) => (child.once("exit", r), child.stdin.end()))
  };
}

// A slash command: a fresh process, as Claude Code spawns it.
const slash = (sessionId, ...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [`${PLUGIN}/src/claude/neatcontext-cli.mjs`, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId }
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", () => resolve(out.trim()));
  });

const statusLine = async (sessionId) =>
  (await slash(sessionId, "status")).split("\n")[0].replace("Connected context: ", "");

const saved = await readFile(SELECTION, "utf8").catch(() => null);
const contexts = (await api("GET", "/v1/contexts")).contexts;
if (contexts.length < 2) {
  console.log("Need two standard contexts in NeatContext to run this. Found:", contexts.length);
  process.exit(0);
}
const [first, second] = contexts;
console.log(`Contexts available: ${contexts.map((c) => c.name).join(", ")}\n`);

const A = openWindow("e2e-window-A");
const B = openWindow("e2e-window-B");

try {
  console.log(`── Window A connects "${first.name}" ─────────────────────────`);
  await slash("e2e-window-A", "use", first.name);
  await A.start();
  await B.start();

  console.log(`  A  status says : ${await statusLine("e2e-window-A")}`);
  console.log(`  A  answers from: ${await A.grounding()}`);
  console.log(`  B  status says : ${await statusLine("e2e-window-B")}`);
  console.log(`  B  answers from: ${await B.grounding()}`);
  console.log(`  B  extra tools : ${(await B.tools()).join(", ") || "(none)"}`);

  console.log(`\n── Window B switches to "${second.name}" ───────────────────`);
  await slash("e2e-window-B", "use", second.name);

  console.log(`  A  status says : ${await statusLine("e2e-window-A")}`);
  console.log(`  A  answers from: ${await A.grounding()}   <-- did A move?`);
  console.log(`  A  extra tools : ${(await A.tools()).join(", ") || "(none)"}`);
  console.log(`  B  status says : ${await statusLine("e2e-window-B")}`);
  console.log(`  B  answers from: ${await B.grounding()}`);

  const aGround = await A.grounding();
  const aStatus = await statusLine("e2e-window-A");
  console.log("\n── Verdict ────────────────────────────────────────────────");
  console.log(
    aGround.includes(second.name)
      ? `  ISOLATION: NO   — B's switch moved window A to "${second.name}".`
      : `  ISOLATION: YES  — window A stayed on "${first.name}".`
  );
  console.log(
    aStatus.includes(aGround.split(" ")[0])
      ? "  CONSISTENCY: YES — A's status matches what A actually answers from."
      : `  CONSISTENCY: NO  — A says "${aStatus}" but answers from "${aGround}".`
  );
} finally {
  await A.close();
  await B.close();
  if (saved !== null) await writeFile(SELECTION, saved);
}
