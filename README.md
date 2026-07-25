# NeatContext plugin for Claude Code

Pick a **NeatContext** context from inside Claude Code and have the whole session
grounded in it — its domain profile, local knowledge, and read-only extension
tools — with no app switching and no copy-paste.

## What it does

- `/neatcontext:list` — list the contexts you can connect.
- `/neatcontext:use [context]` — connect a context to the current session.
- `/neatcontext:status` — show which context is connected.

Once a context is connected, the plugin's MCP server exposes NeatContext's
`get_context` tool, the `analyze_incident` prompt, and the connected context's
**extension tools** (e.g. your incident/log/deploy connectors). Switching
contexts with `/neatcontext:use` again takes effect live — the tool list
refreshes without restarting the session.

## Requirements

- **NeatContext desktop app**, installed and **open**. The plugin talks to it
  over a local-only connection that exists only while the app is running.
- **Node.js 18+** (for the plugin's helper scripts and the MCP bridge).

## Install

From Claude Code:

```
/plugin marketplace add XTSoftwareLabs/neatcontext-claudecode-plugin
/plugin install neatcontext@neatcontext
```

Then open the NeatContext desktop app, run `/neatcontext:use` to connect a
context, and ask your question.

## How it connects

The plugin never reads NeatContext's internals or bundles its binary. It ships a
generic **MCP bridge** (`scripts/mcp-bridge.mjs`) that relays Model Context
Protocol traffic to NeatContext's local companion endpoint, which hosts the real
NeatContext MCP surface. The bridge only speaks:

- standard MCP (the protocol Claude Code already uses for tools/prompts), and
- the documented companion HTTP contract on the loopback interface: a discovery
  file at `~/.neatcontext/companion.json` (port + per-session token; override
  with `NEATCONTEXT_COMPANION_FILE`) and a token-gated `POST /v1/mcp` plus a few
  read endpoints (`/v1/health`, `/v1/contexts`, `/v1/connection`).

The context you pick is recorded next to the discovery file, in
`~/.neatcontext/plugin-selection.json` — a context id and name, nothing else. It
is what lets the plugin reconnect after NeatContext is restarted.

Nothing leaves your machine, and no NeatContext code runs inside the plugin.

## Troubleshooting

- **"NeatContext desktop is not reachable."** Open the NeatContext app and make
  sure a workspace is loaded, then retry.
- **No contexts listed.** Create a context in the NeatContext app first.
- **Extension tools don't appear.** Connect a context first with
  `/neatcontext:use`; the tool list refreshes when you do.
- **You restarted NeatContext mid-session.** The app holds the connection in
  memory, so quitting it disconnects the context. The plugin remembers what you
  selected and reconnects it on the next question — no need to re-run
  `/neatcontext:use`. If the context was deleted from NeatContext in the
  meantime, the plugin says so and asks you to pick another.

## License

MIT — see [LICENSE](LICENSE).
