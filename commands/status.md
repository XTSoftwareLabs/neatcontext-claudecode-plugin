---
description: Show the NeatContext connection status for this session
allowed-tools: Bash(node:*)
---

Report the current connection.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" status`

Relay the status above to the user, keeping it short. If no context is connected,
mention they can connect one with `/neatcontext:use`. If it reports a problem
with a lite context — its files or its knowledge folder gone — relay that too,
along with what to do about it.
