---
description: Choose how this session may switch contexts on its own
argument-hint: [auto|ask|manual]
allowed-tools: Bash(node:*)
---

Set or show how this session routes itself between contexts.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" mode $ARGUMENTS`

Relay the output above as it is. Do not explain the modes again if the command
already listed them, and do not switch context as part of running this command.

The mode applies to every open Claude Code window, because the connected context
does too.
