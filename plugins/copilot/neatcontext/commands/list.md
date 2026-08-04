---
description: List the NeatContext contexts you can connect
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)
---

List the contexts stored by this plugin on this machine.

!`node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" list`

Relay the output above verbatim — it is already the answer. Do not re-format it,
summarize it, or expand on any `(none — ...)` note; those lines say everything
that needs saying. Then one closing line: connect one with
`/neatcontext:use <name>`, or — only when the list is empty — create one
with `/neatcontext:create` or save this conversation with `/neatcontext:save`.
