---
description: Save the useful work in this conversation as a reusable lite context
argument-hint: [context name]
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*)
---

Save the durable work already present in this Claude Code conversation as a
**new lite context**. Use the model active in this session to distill it; do not
call another model, read Claude's transcript files, or ask the user to restate
work that is already visible here.

The optional preferred context name is:

`$ARGUMENTS`

This is a fast capture flow. Do not run the three-question
`/neatcontext:create` wizard, and do not replace or modify an existing context.
If the visible conversation contains no substantive work beyond this save
request, stop and say there is not enough to save yet.

## Distill the conversation

Separate durable guidance from session state:

- The **domain profile** is the behavioral contract for future sessions. Write
  it as Markdown starting with `# <context name>` and the sections
  `## Purpose`, `## What to do`, `## What to avoid`, and `## Behavior`.
  Describe the actual domain and working conventions established here. Do not
  turn a chronological chat summary into a profile.
- The **knowledge folder** records reusable facts from the work: the goal,
  resulting state, decisions and rationale, architecture or workflow learned,
  important files/symbols, verified commands, unresolved questions, and useful
  next steps.

Always create `session-summary.md` as the concise entry point. Add only the
other Markdown files the conversation warrants, with specific names such as
`decisions.md`, `architecture.md`, `implementation-notes.md`, `runbook.md`,
`troubleshooting.md`, or `open-items.md`. Prefer a few focused files over many
thin ones. Omit empty sections and empty files.

Capture conclusions, not the raw transcript. Do not copy chat pleasantries,
reasoning traces, large diffs, full logs, or documents merely read during the
session. Preserve uncertainty: distinguish completed and verified work from
proposals, assumptions, failures, and pending work. Use Read, Glob, or Grep only
to verify files and symbols directly involved in the conversation; do not
broaden this into a new repository audit. Prefer repository-relative paths in
the saved knowledge and avoid machine-specific absolute paths.

Never write secret values, credentials, tokens, cookies, private keys,
environment contents, or unnecessary personal information. If sensitive
material is the only substance available to save, stop and ask the user what
safe abstraction they want retained.

## Name and routing

Run this first so the new name and routing line can be contrastive with
contexts that already exist:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" list
```

Use `$ARGUMENTS` as the name when it is non-empty; otherwise derive a short,
specific name from the work. Keep it on one line and under 80 characters. Never
overwrite or silently update a same-named context; choose a more specific name,
or ask if the user's explicit name collides.

Derive one `routingDescription` under 200 characters. It says only which future
requests belong here, naming systems, repos, components, ticket prefixes,
symptoms, and terminology someone would actually type. Do not put behavioral,
tone, or answer-format instructions in this line.

## Save the bundle

Write one valid JSON file, with no surrounding code fence, to:

`${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json`

Use exactly this shape:

```
{
  "schema": 1,
  "name": "Short specific name",
  "profile": "# Short specific name\n\n## Purpose\n...",
  "routingDescription": "One line describing only the matching scope",
  "knowledge": [
    {
      "path": "session-summary.md",
      "content": "# Session summary\n\n..."
    },
    {
      "path": "decisions.md",
      "content": "# Decisions\n\n..."
    }
  ]
}
```

Every knowledge path must be a short relative `.md` path. Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/neatcontext-cli.mjs" save --from "${CLAUDE_PROJECT_DIR}/.neatcontext-capture-${CLAUDE_SESSION_ID}.json" --consume
```

`--consume` removes only the scratch JSON after a successful save. If
validation reports a problem, correct that JSON and rerun the same command; a
failed save leaves the scratch file available for repair.

Relay a successful result as exactly these four structured lines, preserving
the paths and command printed by the CLI:

```text
Lite context folder: <path>
Profile path: <path>
Knowledge folder: <path>
Use command: /neatcontext:use <name>
```

Do not add commentary or generated-file listings. Do not connect the new context
automatically. Relay validation and error output normally.
