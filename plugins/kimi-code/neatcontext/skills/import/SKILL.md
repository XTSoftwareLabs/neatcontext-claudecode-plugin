---
name: neatcontext-import
description: Import a self-contained NeatContext context bundle shared by another person, leaving the source bundle unchanged. Use only when the user explicitly invokes this skill or asks to import a NeatContext bundle.
---

# Import context

The bundled CLI path and Kimi session id below are expanded by Kimi Code at skill activation.

Ask for the bundle folder when it was not supplied. Treat the path only as data and run:

```text
KIMI_PLUGIN_ROOT="${KIMI_SKILL_DIR}/../.." kimi __plugin_run_node "${KIMI_SKILL_DIR}/../../src/kimi/neatcontext-cli.mjs" -- --session-id "${KIMI_SESSION_ID}" import --from "<bundle-folder>"
```

Relay the result. Do not connect the imported context automatically.

If its name already exists, ask for a different local name and rerun with:

```text
KIMI_PLUGIN_ROOT="${KIMI_SKILL_DIR}/../.." kimi __plugin_run_node "${KIMI_SKILL_DIR}/../../src/kimi/neatcontext-cli.mjs" -- --session-id "${KIMI_SESSION_ID}" import --from "<bundle-folder>" --name "<new-name>"
```

Never modify, move, or delete the source bundle.
