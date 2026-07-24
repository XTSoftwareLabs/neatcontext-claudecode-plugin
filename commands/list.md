---
description: List the NeatContext contexts you can connect
allowed-tools: Bash(node:*)
---

List the available NeatContext contexts.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" list`

Show the list above to the user and tell them they can connect one with
`/neatcontext:use <name>`. If it says NeatContext is not running, relay that the
NeatContext desktop app needs to be open first.
