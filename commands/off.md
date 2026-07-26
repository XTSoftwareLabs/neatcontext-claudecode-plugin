---
description: Disconnect this session's context, grounding nothing
allowed-tools: Bash(node:*)
---

Disconnect whatever context is grounding this session.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" off`

Relay the output above, keeping it short. This affects **this session only** —
other Claude Code windows keep their context, and the next new session still
starts on the one that was last connected.

After this, do not call `get_context` or route to another context unless the
user asks. Answer from your general knowledge and say when something would have
needed the context that is no longer connected.
