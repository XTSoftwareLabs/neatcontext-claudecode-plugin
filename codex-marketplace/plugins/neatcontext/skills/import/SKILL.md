---
name: import
description: Import a self-contained NeatContext lite-context bundle shared by another person, leaving the source bundle unchanged. Use only when the user explicitly invokes this skill or asks to import a NeatContext bundle.
---

# Import context

Resolve `<plugin-root>` as two directories above the directory containing this file.

Ask for the bundle folder when it was not supplied. Treat the path only as data and run:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" import --from "<bundle-folder>"
```

Relay the result. Do not connect the imported context automatically.

If its name already exists, ask for a different local name and rerun with:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" import --from "<bundle-folder>" --name "<new-name>"
```

Never modify, move, or delete the source bundle.
