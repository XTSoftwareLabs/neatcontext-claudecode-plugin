---
description: List the NeatContext contexts you can connect
allowed-tools: Bash(node:*)
---

List the available contexts — standard ones from the NeatContext desktop app,
and lite ones stored by the plugin.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" list`

Show the list above to the user and tell them they can connect one with
`/neatcontext:use <name>`. If it notes that standard contexts aren't listed,
relay that the NeatContext desktop app needs to be open for those; lite contexts
are listed either way. If there are no contexts at all, mention they can create a
lite one with `/neatcontext:create` without installing anything.
