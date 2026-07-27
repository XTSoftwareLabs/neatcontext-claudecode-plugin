---
description: Delete a lite NeatContext context
argument-hint: [lite context name or number]
allowed-tools: Bash(node:*)
---

Delete a lite context. Standard contexts cannot be deleted from here — they are
managed in the NeatContext desktop app.

Your lite contexts:

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" list --lite`

The user asked to delete: $ARGUMENTS

Based on the list above:

- If no name was given, or it does not clearly match exactly one lite context,
  show the list and ask which one they mean. Do not guess.
- If it matches one, run the following preview first:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" delete "<name>"
  ```

  Then **confirm with the user**, relaying exactly what the preview says will
  happen. A fresh context from `/neatcontext:create` points at user-owned
  knowledge that is left untouched. A conversation context from
  `/neatcontext:save` owns generated knowledge inside its bundle, so that
  generated folder is deleted with the context.
- Only after they confirm, run:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" delete "<name>" --yes
  ```

  and relay the result. If the deleted context was the connected one, tell them
  the session is no longer grounded and they can pick another with
  `/neatcontext:use`.
- If the name they gave belongs to a standard context, tell them it has to be
  deleted in the NeatContext desktop app instead.
