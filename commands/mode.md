---
description: Choose how this session may switch contexts on its own
argument-hint: [auto|ask|manual]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Set or show how this session routes itself between contexts.

The user supplied:

`$ARGUMENTS`

Accept only no argument, one of `auto`, `ask`, or `manual`, and an optional
trailing `--global`. If anything else was supplied, do not run it as shell
input; show the accepted form instead.

Run the bundled CLI with the validated literal mode:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" mode <mode> [--global]
```

Omit `<mode> [--global]` when the user supplied no argument. Relay the output
as it is. Do not explain the modes again if the command already listed them,
and do not switch context as part of running this command.

The mode set here applies to this session only.
`/neatcontext:mode <mode> --global` changes the default for new sessions
instead.
