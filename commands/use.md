---
description: Connect a NeatContext context to this session
argument-hint: [context name or number]
allowed-tools: Bash(node:*)
---

Connect a context so the rest of this session is grounded in it. Works for both
standard contexts (from the NeatContext desktop app) and lite contexts (created
here with `/neatcontext:create`).

Result of the selection attempt:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" use $ARGUMENTS`

Based on the output above:

- If it confirms a context was connected, tell the user which context is now
  active and stop there — do not run a second command or tool call to verify it.
  From now on, call the `get_context` tool to ground answers. For a standard
  context the `analyze_incident` prompt and the context's extension tools also
  become available; a lite context serves only `get_context`. Do not restate the
  context contents.
- If it lists available contexts (because none was given or the name was
  ambiguous), show that list and ask which one to use.
- If it says the NeatContext desktop app is not running, relay that standard
  contexts need the app open, and that lite contexts work without it.
