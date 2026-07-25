# NeatContext plugin for Claude Code

Ground a whole Claude Code session in your team's context — its domain profile,
local knowledge, and read-only extension tools — with no app switching and no
copy-paste.

There are two kinds of context:

- **Standard** — created in the **NeatContext desktop app**: many domain
  profiles, many knowledge folders with indexed retrieval, and extension tools.
- **Lite** — created right here with `/neatcontext:create`: **one** domain
  profile and **one** knowledge folder, no extensions. It is stored locally by
  the plugin and works with the desktop app closed, or never installed.

## What it does

- `/neatcontext:list` — list the contexts you can connect, of both kinds.
- `/neatcontext:use [context]` — connect a context to the current session.
- `/neatcontext:status` — show which context is connected.
- `/neatcontext:create` — create a lite context, in three questions.
- `/neatcontext:delete [context]` — delete a lite context.

Once a context is connected, the plugin's MCP server exposes the `get_context`
tool. A **standard** context adds the context's **extension tools** (e.g. your
incident/log/deploy connectors); switching contexts with `/neatcontext:use`
takes effect live — the tool list refreshes without restarting the session. A
**lite** context serves only `get_context`.

The plugin does not surface NeatContext's `analyze_incident` prompt. A context
is whatever you made it, and many are not about incidents at all, so an
incident-shaped command in the menu would misrepresent what is connected.

Each session is also framed by the context it starts with, so restarting Claude
Code with a context already connected picks up where you left off — you don't
have to run `/neatcontext:use` again. A **standard** context is framed by
NeatContext, a **lite** context by the plugin, in plain terms that assume nothing
about your subject area.

## Lite contexts

`/neatcontext:create` asks three questions:

1. **What is this context for?** What it covers, what Claude should do, what it
   should avoid, how it should behave. Claude shapes your answer into a domain
   profile and shows it to you before saving.
2. **Which folder holds the knowledge?** Point it at a folder of TSGs, runbooks,
   postmortems, or docs. The folder is referenced where it is — nothing is
   copied or moved.
3. **What should it be called?**

The context is then stored under `~/.neatcontext/lite/<name>/` as a
`context.json` and a `profile.md` you can edit by hand at any time. It stays
there until you remove it with `/neatcontext:delete`, which deletes those two
files and **never touches your knowledge folder**. Standard contexts can't be
deleted from Claude Code — those are managed in the desktop app.

Because `get_context` hands Claude the profile path and the folder path, Claude
reads and searches them with its own file tools. That is all a lite context is:
no index, no extensions, no live evidence connectors.

## Requirements

- **Node.js 18+** (for the plugin's helper scripts and the MCP bridge).
- For **standard** contexts: the **NeatContext desktop app**, installed and
  **open**. The plugin talks to it over a local-only connection that exists only
  while the app is running. Lite contexts need neither.

## Install

From Claude Code:

```
/plugin marketplace add XTSoftwareLabs/neatcontext-claudecode-plugin
/plugin install neatcontext@neatcontext
```

Then either run `/neatcontext:create` to make a lite context on the spot, or open
the NeatContext desktop app and run `/neatcontext:use` to connect a standard one.

## How it connects

A session is served by one of two sources, chosen from the context you selected.

**Lite contexts** are served locally, straight from the files above. No HTTP, no
desktop app, nothing leaves your machine.

**Standard contexts** are served by NeatContext. The plugin never reads
NeatContext's internals or bundles its binary. It ships a generic **MCP bridge**
(`scripts/mcp-bridge.mjs`) that relays Model Context Protocol traffic to
NeatContext's local companion endpoint, which hosts the real NeatContext MCP
surface. The bridge only speaks:

- standard MCP (the protocol Claude Code already uses for tools/prompts), and
- the documented companion HTTP contract on the loopback interface: a discovery
  file at `~/.neatcontext/companion.json` (port + per-session token; override
  with `NEATCONTEXT_COMPANION_FILE`) and a token-gated `POST /v1/mcp` plus a few
  read endpoints (`/v1/health`, `/v1/contexts`, `/v1/connection`).

The context you pick is recorded next to the discovery file, in
`~/.neatcontext/plugin-selection.json` — a kind, a context id, and a name,
nothing else. For a standard context it is what lets the plugin reconnect after
NeatContext is restarted; for a lite context it *is* the connection, since no app
is holding one.

Nothing leaves your machine, and no NeatContext code runs inside the plugin.

## Troubleshooting

- **"NeatContext desktop is not reachable."** Open the NeatContext app and make
  sure a workspace is loaded, then retry. Only standard contexts need it.
- **No contexts listed.** Create a lite one with `/neatcontext:create`, or a
  standard one in the NeatContext app.
- **Extension tools don't appear.** They come only from a standard context —
  lite contexts have none. Connect one with `/neatcontext:use`; the tool list
  refreshes when you do.
- **Your lite context stopped working.** `/neatcontext:status` reports it if the
  context's own files or its knowledge folder have been moved or deleted.
- **You restarted NeatContext mid-session.** The app holds the connection in
  memory, so quitting it disconnects the context. The plugin remembers what you
  selected and reconnects it on the next question — no need to re-run
  `/neatcontext:use`. If the context was deleted from NeatContext in the
  meantime, the plugin says so and asks you to pick another.

## License

MIT — see [LICENSE](LICENSE).
