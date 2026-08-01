# NeatContext for pi

Extract domain knowledge and save useful work from [pi](https://pi.dev)
conversations as structured, reusable context that you can use in later sessions
or share with others.

Part of [NeatContext plugins](https://github.com/XTSoftwareLabs/neatcontext-plugins),
which also supports Claude Code, Codex, and Kimi Code.

## Why

Domain knowledge is what helps a model answer accurately for your team — your
systems, constraints, decisions, terminology, and ways of working.

You build that knowledge while doing hard work with a coding agent. Long
conversations about debugging, planning, incidents, and implementation already
contain discoveries that will matter again. NeatContext extracts the durable
knowledge from those conversations and saves it as a structured context.

Connect that context in a new session and the agent starts with the knowledge it
needs instead of asking you to explain everything again.

## Install

```bash
pi install npm:@xtsoftwarelabs/neatcontext-pi
```

## Commands

| Command | What it does |
| --- | --- |
| `/neatcontext-status` | What this session is grounded in, and its routing mode |
| `/neatcontext-list` | Every context you can connect (`--lite` for lite only) |
| `/neatcontext-use [name]` | Connect a context. With no name, pick from a list |
| `/neatcontext-disconnect` | Disconnect this session's context |
| `/neatcontext-mode [auto\|ask\|manual]` | How this session may re-ground itself (`--global` for the default) |
| `/neatcontext-create` | Create a lite context around a knowledge folder you already have |
| `/neatcontext-save [name]` | Save this conversation's durable work as a context |
| `/neatcontext-import <folder>` | Import a shared conversation-context bundle |
| `/neatcontext-delete <name>` | Delete a lite context |

Each session has its own context and its own routing mode. Two pi windows can
work on different contexts at once without disturbing each other.

## Routing

With a context connected, the model sees a one-line description of every other
context on the machine and can move the session to a better one:

- **ask** (default) — it proposes a switch and waits for you.
- **auto** — it switches on a clear match and tells you it did.
- **manual** — it never routes; `/neatcontext-use` only.

Decline a switch once and it will not be suggested again in that session. When
routing gets it wrong, say what you call the subject — the model records that as
an alias so the same words route correctly next time.

## How it differs from the other hosts

pi has no built-in MCP, [by design](https://github.com/earendil-works/pi/issues/563).
The other three NeatContext plugins ship an MCP server that the host launches
beside the agent; this one is a pi extension that runs *inside* the agent
process. Three consequences worth knowing:

- **Session identity is exact.** `ctx.sessionManager.getSessionId()` is
  available directly, so per-session isolation needs none of the environment
  plumbing the other hosts require.
- **Grounding is rebuilt every turn.** MCP fixes its session instructions at the
  handshake and can never revise them. Here they are recomputed in
  `before_agent_start`, so a context switch or a mode change takes effect on the
  next message rather than the next restart.
- **The tool list is fixed for the session.** MCP hosts add and remove tools live.
  pi cannot, so `use_context` stays registered and *refuses* in manual mode
  instead of disappearing, and a standard context's extension tools are reached
  through one `neatcontext_tool` proxy rather than being registered one-for-one.
  The user-visible behavior is the same; the token cost is lower.

## Privacy

The plugin stores contexts under `~/.neatcontext/` on your machine and talks to
the NeatContext desktop app only over `127.0.0.1` if that app is installed and open. It
sends nothing anywhere else. See
[PRIVACY.md](https://github.com/XTSoftwareLabs/neatcontext-plugins/blob/main/PRIVACY.md).

pi extensions run with full permissions. Read the source before installing —
it is all in `extensions/` and `src/`, dependency-free, and uses only Node
built-ins.

## License

MIT
