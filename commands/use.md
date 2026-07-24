---
description: Connect a NeatContext context to this session
argument-hint: [context name or number]
allowed-tools: Bash(node:*)
---

Connect a NeatContext context so the rest of this session is grounded in it.

Result of the selection attempt:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" use $ARGUMENTS`

Based on the output above:

- If it confirms a context was connected, tell the user which context is now
  active and that their next questions will be answered using that context's
  domain profile and local knowledge. Do not restate the context contents.
- If it lists available contexts (because none was given or the name was
  ambiguous), show that list and ask which one to use.
- If it says NeatContext is not running, relay that the user needs to open the
  NeatContext desktop app first.
