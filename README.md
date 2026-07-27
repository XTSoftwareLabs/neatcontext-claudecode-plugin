# NeatContext for Claude Code

Save useful work from a Claude Code conversation as a reusable context, then
bring it into a later session. You can also create contexts from your own
documentation or connect contexts from the NeatContext desktop app.

## Why NeatContext?

Domain knowledge is what helps an LLM answer accurately for your team—your
systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while doing hard work with Claude. Long
conversations about debugging, planning, incidents, and implementation already
contain discoveries that will matter again. NeatContext extracts the durable
knowledge from those conversations and saves it as a structured context.

Connect that context in a new session or during later work, and Claude can start
with the knowledge it needs instead of asking you to explain everything again.
You can also share the context with teammates, so the whole team benefits from
what one person learned.

### How is this different from saving or resuming a conversation?

| | Best for | What you get |
|---|---|---|
| **NeatContext** | Reusing knowledge in fresh sessions or across a team | A lite context generated for you:<ul><li><strong>1 domain profile:</strong> your team's rules that guide LLM behavior.</li><li><strong>1 knowledge folder:</strong> TSGs, runbooks, and other team knowledge.</li></ul> Both are generated automatically. Together, they provide reusable context—not just a conversation transcript. See [Context types](#context-types) for details. |
| **Claude Code resume** | Continuing the same conversation | The original session and its conversation history |
| **Save or export a conversation** | Keeping a record | The raw transcript, including the back-and-forth that led to the result |

**NeatContext keeps what will help Claude work accurately next time, without carrying over the entire chat.**

## Install

In Claude Code, run:

```text
/plugin marketplace add XTSoftwareLabs/neatcontext-claudecode-plugin
/plugin install neatcontext@neatcontext
```

Requirements:

- Claude Code 2.1.196 or later
- Node.js 18 or later
- The NeatContext desktop app only if you want to use standard contexts created
  in the app

## Quick start: reuse a complex investigation

Suppose you work through a difficult production issue with Claude:

```text
You: Some orders take ten minutes to update, but overall queue lag looks normal.
     Help me investigate.

Claude: The delay affects only one partition. Its consumer is spending most of
        its time deserializing a small number of unusually large events.

You: Those events come from bulk catalog updates. They all use the same tenant
     ID as the partition key. Could that explain the pattern?

Claude: Yes. The shared key sends every bulk update to one partition. Large
        payloads then block later order events in that partition, while the
        aggregate lag metric hides the hotspot.

You: We confirmed it. Splitting the bulk updates removed the delay. In future,
     check per-partition lag, event size, partition keys, and deserialization
     time before scaling consumers.

You: /neatcontext:save event-partition-investigation

Claude:
Lite context folder: <folder>
Profile path: <folder>/profile.md
Knowledge folder: <folder>/knowledge
Use command: /neatcontext:use event-partition-investigation
```

The saved context keeps the investigation approach, system knowledge, findings,
and verified resolution—not the raw conversation. It is not connected
automatically.

When a similar issue appears later, connect the saved context in a new Claude
Code session:

```text
You: /neatcontext:use event-partition-investigation

Claude: Connected to event-partition-investigation.

You: Shipment updates are delayed, but overall queue lag is low. Help me
     investigate.

Claude: I will start with the checks from the saved context: per-partition lag,
        event size, partition keys, and deserialization time.
```

## Commands

### `/neatcontext:save [name]`

Save the useful work in the current conversation as a new lite context. The
name is optional; Claude chooses a specific name if you omit it.

Use this after a conversation has produced decisions, plans, troubleshooting
results, implementation notes, or other work worth continuing later.

### `/neatcontext:use [name or number]`

Connect a context to the current session. You can connect either a lite context
or a standard context from the NeatContext desktop app.

Run the command without a name to see the available choices. Each Claude Code
window keeps its own connected context.

### `/neatcontext:list`

List all contexts you can connect. Lite contexts appear first, followed by
standard contexts available from the NeatContext desktop app.

### `/neatcontext:status`

Show the context connected to the current session and the current routing mode.
It also reports problems such as missing lite-context files or knowledge
folders.

### `/neatcontext:create`

Create a fresh lite context instead of saving the current conversation. Claude
asks what the context is for, which existing folder contains its knowledge, and
what to call it.

The knowledge folder stays where it is; the command does not copy or move it.

### `/neatcontext:import [folder]`

Import a lite context bundle shared by someone else. Import creates your own
local copy and leaves the shared folder unchanged.

After importing, connect it with `/neatcontext:use <name>`.

### `/neatcontext:delete [name or number]`

Delete a lite context after confirmation. Standard contexts must be deleted in
the NeatContext desktop app.

For a context created with `/neatcontext:create`, your original knowledge folder
is left untouched. For a context created with `/neatcontext:save`, its generated
knowledge is deleted with the context.

### `/neatcontext:mode [auto|ask|manual]`

Choose how the current session switches between contexts:

- `ask` — ask before switching; this is the default
- `auto` — switch on a clear match and tell you; ask when the choice is unclear
- `manual` — switch only when you run `/neatcontext:use`

Run `/neatcontext:mode` without an argument to show the current mode. Add
`--global` to set the default for new sessions:

```text
/neatcontext:mode auto --global
```

## Context types

### Lite context

A lite context contains:

- **One domain profile** — your team's rules, terminology, constraints, and
  preferred ways of working. It guides how Claude behaves and answers.
- **One knowledge folder** — TSGs, runbooks, decisions, troubleshooting notes,
  session summaries, and other knowledge Claude can use.
- **No extensions.**

Lite contexts work locally without NeatContext Desktop. Use
`/neatcontext:save` to generate one from the current conversation,
`/neatcontext:create` to use an existing knowledge folder, or
`/neatcontext:import` to add one shared by a teammate.

### Standard context

A standard context contains:

- **One domain profile** — the team's rules that guide Claude's behavior.
- **Multiple knowledge folders** — indexed collections of team documentation
  that Claude can search for relevant information.
- **Extensions** — connections to internal and external systems that let Claude
  use the tools available to the context.

Standard contexts are intended for enterprise-level use. Create and manage them
in [NeatContext Desktop](https://www.neatcontext.com), which must be installed
and open while you use them.

## License

MIT — see [LICENSE](LICENSE).
