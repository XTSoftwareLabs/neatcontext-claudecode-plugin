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

If it says the routing description was derived from an older version of the
profile, offer to refresh it: read the profile, write a fresh one-line scope
description the same way `/neatcontext:use` does, and record it with
`neatcontext-cli.mjs describe "<name>" --use-when "<line>"`.

Keep `/neatcontext:create` and `/neatcontext:save` distinct when suggesting a
next step: create starts a fresh context from user answers; save distills useful
work already in the current conversation.
