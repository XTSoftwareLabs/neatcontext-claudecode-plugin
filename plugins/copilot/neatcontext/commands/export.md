---
description: Export a saved context as a bundle folder you can share
argument-hint: "[lite context name] [destination folder]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs":*)
---

Export a lite context saved from a conversation into a self-contained bundle
folder, so it can be copied to another machine or handed to a teammate and
brought back in with `/neatcontext:import`.

Your lite contexts:

!`node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" list --lite`

The user asked to export: $ARGUMENTS

Work out which context and which destination folder they mean:

- The destination is the folder the bundle is written **into**. A subfolder
  named after the context is created there, so one folder can hold several
  exports.
- If no destination was given, ask for it and stop.
- If no context was named, the connected one is used. If none is connected,
  show the list above and ask which one they mean. Do not guess.

Then run, passing each value as its own quoted argument:

```
node "${CLAUDE_PLUGIN_ROOT}/src/copilot/neatcontext-cli.mjs" export "<name>" --to "<destination folder>"
```

Relay the result. Points to cover when they come up:

- A context made by `/neatcontext:create` cannot be exported. It links a folder
  the plugin does not own, so there is nothing self-contained to hand over. The
  command says so; relay that they should copy that folder across themselves and
  re-create the context on the other machine.
- If the destination already holds a bundle for this context, the command
  refuses. Confirm with the user that replacing it is what they want, then rerun
  the same command with `--force`.
- The exported bundle is a copy. The context in this session is unchanged and
  stays connected.
