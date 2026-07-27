---
description: List the NeatContext contexts you can connect
allowed-tools: Bash(node:*)
---

List the available contexts — lite ones stored by the plugin first, then
standard ones from the NeatContext desktop app.

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" list`

Relay the output above verbatim — it is already the answer. Do not re-format it,
summarize it, explain the two kinds, or expand on any `(none — ...)` note; those
lines say everything that needs saying. Then one closing line: connect one with
`/neatcontext:use <name>`, or — only when both sections are empty — create a
lite one with `/neatcontext:create` or save this conversation with
`/neatcontext:save`.
