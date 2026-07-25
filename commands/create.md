---
description: Create a lite NeatContext context from here, no desktop app needed
allowed-tools: Bash(node:*), Write
---

Guide the user through creating a **lite context**: one domain profile, one
knowledge folder, no extensions. It is stored locally by the plugin and works
whether or not the NeatContext desktop app is installed.

Ask these three questions **one at a time**, waiting for each answer. Do not run
any command until all three are answered.

1. **What is this context for?** Ask them to describe what it covers, what you
   should do, what you should avoid, and how you should behave. This becomes the
   domain profile — your primary behavioral guide whenever the context is
   connected, so encourage specifics over generalities.
2. **Which folder holds the knowledge?** Ask for a path to an existing folder,
   and tell them to put their TSGs, runbooks, postmortems, or other docs there.
   The folder is referenced where it is — nothing is copied or moved.
3. **What should the context be called?** A short name they will type after
   `/neatcontext:use`.

Then, before creating anything:

- Shape answer 1 into a markdown profile with the sections `## Purpose`,
  `## What to do`, `## What to avoid`, and `## Behavior`, keeping their wording
  and adding nothing they did not say. Start it with `# <context name>`.
- **Show the drafted profile to the user and ask them to confirm or amend it.**
  It is the whole behavioral contract of the context, so they should see it
  before it is saved.

Once they confirm, write the profile with the Write tool to a file in your
scratchpad directory (e.g. `profile.md`) — never pass the prose as a command-line
argument, it will not survive shell quoting — then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" create --name "<name>" --knowledge "<folder>" --profile-from "<scratchpad>/profile.md"
```

On Windows, strip any trailing backslash from the folder path before quoting it —
`"C:\docs\"` escapes the closing quote and mangles the argument.

Relay the result. On success it prints the exact `/neatcontext:use` command —
show that to the user so they can connect it. Do not connect it yourself.

If it reports a problem (missing folder, duplicate name, empty profile), tell the
user what it said, ask for a corrected answer to just that question, and run the
command again.
