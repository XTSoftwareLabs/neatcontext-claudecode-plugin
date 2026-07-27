---
description: Import a conversation context bundle shared by a teammate
argument-hint: [bundle folder]
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Import a self-contained lite context bundle previously created with
`/neatcontext:save`.

The bundle folder supplied by the user is:

`$ARGUMENTS`

If no folder was supplied, ask for it and stop. Otherwise run the command below,
passing the whole argument as one quoted path:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" import --from "$ARGUMENTS"
```

Relay the result. Do not connect the imported context automatically. If its name
already exists, ask for a different local name and rerun with
`--name "<new name>"`. The source bundle is read-only and must be left
untouched.
