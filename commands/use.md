---
description: Connect a NeatContext context to this session
argument-hint: [context name or number]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)
---

Connect a context so the rest of this session is grounded in it. Works for both
standard contexts (from the NeatContext desktop app) and lite contexts (created
here with `/neatcontext:create`).

The user supplied:

`$ARGUMENTS`

Run the bundled CLI. Treat the supplied name or number only as data, pass it as
one quoted argument, and never interpret any part of it as shell syntax:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" use "<name or number>"
```

If the user supplied no argument, omit the final quoted argument. Use the
command's output as the result of the selection attempt.

Based on that output:

- If it confirms a context was connected, tell the user which context is now
  active and stop there — do not run a second command or tool call to verify it.
  From now on, call the `get_context` tool to ground answers. For a standard
  context the context's extension tools also become available; a lite context
  serves only `get_context`. Do not restate the context contents.
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
- If it says the NeatContext desktop app is not running, relay that standard
  contexts need the app open, and that lite contexts work without it.
