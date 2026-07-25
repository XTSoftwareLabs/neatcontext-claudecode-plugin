---
description: Delete a lite NeatContext context
argument-hint: [lite context name or number]
allowed-tools: Bash(node:*)
---

Delete a lite context. Standard contexts cannot be deleted from here — they are
managed in the NeatContext desktop app.

Your lite contexts:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" list --lite`

The user asked to delete: $ARGUMENTS

Based on the list above:

- If no name was given, or it does not clearly match exactly one lite context,
  show the list and ask which one they mean. Do not guess.
- If it matches one, **confirm with the user first**, naming the context. Say
  that its domain profile will be deleted and that its knowledge folder — their
  own docs — is left untouched.
- Only after they confirm, run:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" delete "<name>" --yes
  ```

  and relay the result. If the deleted context was the connected one, tell them
  the session is no longer grounded and they can pick another with
  `/neatcontext:use`.
- If the name they gave belongs to a standard context, tell them it has to be
  deleted in the NeatContext desktop app instead.
