# NeatContext for GitHub Copilot

Extract domain knowledge and preserve useful work from GitHub Copilot
conversations as structured, reusable context that you can reconnect in later
sessions or share with your team.

One plugin serves both Copilot hosts: **Copilot CLI** and **Copilot in VS Code**
(Agent Plugins preview). It is a Claude-format plugin, which both hosts install
natively.

## Why NeatContext?

Domain knowledge is what helps Copilot work accurately in your environment:
your systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while debugging, planning, investigating
incidents, and implementing features. Those conversations contain discoveries
that will matter again, but without a durable context they remain trapped in
one session.

NeatContext extracts the reusable knowledge from that work and saves it as a
structured context. Reconnect it when you return to the domain so Copilot can
start with the knowledge it needs, or share it with teammates so everyone
benefits from what one person learned.

## Install

### Copilot CLI

```bash
copilot plugin install XTSoftwareLabs/neatcontext-plugins:plugins/copilot/neatcontext
```

Or from the marketplace (its Copilot-format index lives at
`.github/plugin/marketplace.json` and is named `neatcontext`):

```bash
copilot plugin marketplace add XTSoftwareLabs/neatcontext-plugins
copilot plugin install neatcontext-copilot@neatcontext
```

### Copilot in VS Code (Agent Plugins preview)

Agent plugins are a preview feature: enable the `chat.plugins.enabled` setting
first. Then add the marketplace and install:

1. Add `XTSoftwareLabs/neatcontext-plugins` to the `chat.plugins.marketplaces`
   setting, and install the plugin from the Extensions view — or run the
   `Chat: Install Plugin From Source` command on a local clone of this
   repository, pointing it at `plugins/copilot/neatcontext`.
2. Reload the window when prompted.

## Commands

- `/neatcontext:save [name]` — save reusable work from the visible conversation.
- `/neatcontext:use [name or number]` — connect or switch this workspace.
- `/neatcontext:disconnect` — disconnect only this workspace.
- `/neatcontext:list` — list the lite contexts on this machine.
- `/neatcontext:status` — show the selection and routing mode.
- `/neatcontext:create` — create a lite context around an existing knowledge folder.
- `/neatcontext:import [folder]` — import a shared lite-context bundle.
- `/neatcontext:export [name] [folder]` — export a saved context as a shareable bundle.
- `/neatcontext:delete [name or number]` — preview and delete a lite context.
- `/neatcontext:mode [auto|ask|manual]` — show or change routing behavior.

## Scope and host differences

- **Lite contexts only.** The Copilot plugin stores its contexts itself, on
  this machine, and never talks to the NeatContext desktop app. Standard
  contexts (desktop-app extensions, indexed retrieval) are available through
  the Claude Code plugin instead.
- **Selections are per workspace.** Copilot does not expose a session identity
  to plugin processes, so a connected context belongs to the workspace folder:
  every Copilot session opened in that folder shares it.
- **The save nudge needs Stop/PreCompact hook events.** VS Code's Claude-compat
  hook runtime can deliver them; Copilot CLI has no such events, so on the CLI
  the nudge is silently inert and saving stays user-initiated via
  `/neatcontext:save`. The hooks are fail-silent by design: on any host
  shortfall they do nothing rather than break the session.

Lite contexts created here are shared with the other NeatContext plugins on
this machine — a context saved from Claude Code can be connected from Copilot,
and vice versa.

See the repository [Privacy Policy](../../../PRIVACY.md) for storage, network,
retention, and model-provider details.
