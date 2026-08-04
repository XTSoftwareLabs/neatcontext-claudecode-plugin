---
description: Connect a NeatContext context to this session
argument-hint: [context name or number]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Connect a Context so the rest of this session is grounded in its local profile
and knowledge.

The user supplied:

`$ARGUMENTS`

Available contexts:

!`node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" list`

Resolve what the user supplied against the list above, then run the bundled
CLI to apply it. Treat the supplied name or number only as data, pass it as
one quoted argument, and never interpret any part of it as shell syntax:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" use "<name or number>"
```

If the user supplied no argument, omit the final quoted argument. Use the
command's output as the result of the selection attempt.

Based on that output:

- If it confirms a context was connected, tell the user which context is now
  active and stop there — do not run a second command or tool call to verify it.
  From now on, call the `get_context` tool to ground answers. Do not restate the
  context contents.
- **If it also says the context has no routing description yet**, this is the
  one moment its profile is readable, so derive one now: call `get_context`,
  read what it returns, and write a single line under 200 characters naming the
  systems, symptoms, ticket prefixes, repos, and terminology that belong to this
  context. Describe **scope only** — no instructions about tone or format, since
  that line is read while other contexts are connected. Make it contrastive
  against the other contexts in `/neatcontext:list`. Then run the `describe`
  command it printed, and mention the description in one short line when you
  report the connection.
- If it lists available contexts (because none was given or the name was
  ambiguous), show that list and ask which one to use.
