---
description: Disconnect the NeatContext context from this session
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Disconnect the context currently connected to this Claude Code session.

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" disconnect`

Relay the result verbatim. Do not run a status command afterward. This affects
only the current session; other Claude Code windows keep their own connections.
