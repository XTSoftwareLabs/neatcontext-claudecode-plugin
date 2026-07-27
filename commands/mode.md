---
description: Choose how this session may switch contexts on its own
argument-hint: [auto|ask|manual]
allowed-tools: Bash(node:*)
---

Set or show how this session routes itself between contexts.

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" mode $ARGUMENTS`

Relay the output above as it is. Do not explain the modes again if the command
already listed them, and do not switch context as part of running this command.

The mode set here applies to this session only. `/neatcontext:mode <mode>
--global` changes the default for new sessions instead.
