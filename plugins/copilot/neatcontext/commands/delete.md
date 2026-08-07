---
description: Delete a NeatContext Context
argument-hint: "[context name or number]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)
---

Delete a context.

Your contexts:

!`node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" list`

The user asked to delete: $ARGUMENTS

Based on the list above:

- If no name was given, or it does not clearly match exactly one context,
  show the list and ask which one they mean. Do not guess.
- If it matches one, run the following preview first:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" delete "<name>"
  ```

  Then **confirm with the user**, relaying exactly what the preview says will
  happen. A fresh context from `/neatcontext:create` points at user-owned
  knowledge that is left untouched; any conversation additions later saved
  into its local bundle are deleted with the context. A conversation context
  first made by `/neatcontext:save` owns all generated knowledge inside its
  bundle, so that generated folder is deleted with the context.
- Only after they confirm, run:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" delete "<name>" --yes
  ```

  and relay the result. If the deleted context was the connected one, tell them
  the session is no longer grounded and they can pick another with
  `/neatcontext:use`.
