# NeatContext plugin for Claude Code

Pick a **NeatContext** context from inside Claude Code and have every answer in
the session grounded in that context's domain profile and local knowledge — no
app switching, no copy-paste.

## What it does

- `/neatcontext:use [context]` — connect a context to the current session.
- `/neatcontext:status` — show which context is connected.
- Once a context is connected, a `UserPromptSubmit` hook injects the context's
  pointers (profile file paths + knowledge folder paths) before each prompt, so
  Claude Code reads and searches those local sources with its own tools.

You can switch contexts at any time by running `/neatcontext:use` again — it
takes effect on your next message, with no restart.

## Requirements

- **NeatContext desktop app**, installed and **open**. The plugin talks to it
  over a local-only connection that exists only while the app is running.
- **Node.js 18+** (for the plugin's small helper scripts and the hook).

## Install

From Claude Code:

```
/plugin marketplace add XTSoftwareLabs/neatcontext-claudecode-plugin
/plugin install neatcontext@neatcontext
```

Then open the NeatContext desktop app and run `/neatcontext:use` in Claude Code.

## How it connects

The plugin never reads NeatContext's internals. It uses a small, stable public
integration surface the desktop app exposes on the loopback interface while it
is open:

- a discovery file at `~/.neatcontext/companion.json` holding the local port and
  a per-session token (override with the `NEATCONTEXT_COMPANION_FILE`
  environment variable), and
- a handful of read-oriented HTTP endpoints (`/v1/health`, `/v1/contexts`,
  `/v1/connection`, `/v1/context`), all gated by the token.

The endpoints expose only context names and pointer text (paths to your local
files). No file contents, model credentials, or connection secrets ever cross
this boundary, and nothing leaves your machine.

## Troubleshooting

- **"NeatContext desktop is not running."** Open the NeatContext app and make
  sure a workspace is loaded, then retry.
- **No contexts listed.** Create a context in the NeatContext app first.
- **The hook adds nothing.** That is expected until you connect a context with
  `/neatcontext:use`.

## License

MIT — see [LICENSE](LICENSE).
