---
name: delete
description: Preview and permanently delete a NeatContext lite context while preserving any externally linked knowledge folder. Use only when the user explicitly invokes this skill or clearly asks to delete a lite context.
---

# Delete context

Resolve `<plugin-root>` as two directories above the directory containing this file.

List lite contexts first:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" list --lite
```

If the requested name is missing or does not resolve to exactly one lite context, show the list and ask which one. Never guess. Standard contexts must be deleted in the NeatContext desktop app.

Preview the deletion without changing anything:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" delete "<exact-name>"
```

Relay exactly what the preview says will be removed or retained and wait for explicit confirmation.

After confirmation, run:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" delete "<exact-name>" --yes
```

Relay the result. If it was connected, say that this thread is no longer grounded and suggest `$neatcontext:use`.
