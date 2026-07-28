---
name: list
description: List the NeatContext lite and standard contexts available to the current Codex thread. Use when the user asks what contexts exist, what can be connected, or explicitly invokes this skill.
---

# List contexts

Resolve `<plugin-root>` as two directories above the directory containing this file. Run:

```text
node "<plugin-root>/src/codex/neatcontext-cli.mjs" list
```

Relay the output verbatim. Do not reformat or explain its `(none - ...)` notes.

Close with one short line: connect a context with `$neatcontext:use <name>`. Only when both sections are empty, also mention `$neatcontext:create` and `$neatcontext:save`.
