---
description: Show the NeatContext connection status for this session
allowed-tools: Bash(node:*)
---

Report the current NeatContext connection.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" status`

Relay the status above to the user in one line. If no context is connected,
mention they can connect one with `/neatcontext:use`.
