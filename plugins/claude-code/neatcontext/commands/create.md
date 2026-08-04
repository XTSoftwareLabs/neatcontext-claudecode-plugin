---
description: Create a local NeatContext Context around an existing knowledge folder
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*), Write
---

Guide the user through creating a **Context**: one domain profile and one
knowledge folder. It is stored locally by the plugin.

This remains the deliberate flow for a fresh context. If the user wants to
distill work already present in the current conversation, direct them to
`/neatcontext:save` instead.

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
- Derive a **routing description** from that profile: one sentence, under 200
  characters, saying what kinds of question belong to this context. Name the
  systems, symptoms, ticket prefixes, repos, and terminology someone would
  actually type — this is what a future session matches a request against when
  deciding whether to switch here.
  - Describe **scope only**. No instructions about tone, format, or how to
    answer: this line is read while another context is connected, and
    behavioral text in it would bleed into unrelated answers.
  - Run `/neatcontext:list` first and make it **contrastive**. If a context
    already covers something adjacent, say what distinguishes this one. Two
    contexts that both describe themselves as "payments questions" cannot be
    told apart by anything downstream.
- **Show the drafted profile and the routing description to the user and ask
  them to confirm or amend both.** The profile is the whole behavioral contract
  of the context, and the routing description decides when it gets used, so they
  should see both before anything is saved.

Once they confirm, write the profile with the Write tool to a file in your
scratchpad directory (e.g. `profile.md`) — never pass the prose as a command-line
argument, it will not survive shell quoting — then run:

```
node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs" create --name "<name>" --knowledge "<folder>" --profile-from "<scratchpad>/profile.md" --use-when "<routing description>"
```

The routing description is a single line, so it does survive quoting — but keep
it free of double quotes.

On Windows, strip any trailing backslash from the folder path before quoting it —
`"C:\docs\"` escapes the closing quote and mangles the argument.

Relay the result. On success it prints the exact `/neatcontext:use` command —
show that to the user so they can connect it. Do not connect it yourself.

If it reports a problem (missing folder, duplicate name, empty profile), tell the
user what it said, ask for a corrected answer to just that question, and run the
command again.
