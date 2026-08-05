---
description: Show what the connected context expects to reach, and whether this machine provides it
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Report what the connected context's extensions can and cannot do here.

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" extensions`

Relay the report above. Two separate things are being reported and the
difference matters to the user:

- What the **context** expects — the extension it declares and the capability
  that provides. This travels with the context, and it is the same on every
  machine the context reaches.
- What **this machine** provides for it. That is local, hand-written, and lives
  in the bindings file the report names. Nothing configures it automatically,
  and nothing in a shared context can configure it.

If something is reported as not configured, show the example binding from the
report and say where the file goes. Tell them to keep credentials in the
environment and name them under `envFrom`, rather than writing them into the
file.

If an extension is reported as unavailable or failed, relay the reason as given
— a command that is not there, a server that did not answer — and do not guess
at a fix beyond what the report says.

Say plainly that the context still works: its profile and knowledge folder are
served whether or not any extension is configured.

If the user wants this context to expect something new, use
`neatcontext-cli.mjs extensions add <id> --capability "<what it lets this
context do>"`, optionally with `--tools a,b` and `--important`. That records
what the context wants; it connects nothing on its own.
