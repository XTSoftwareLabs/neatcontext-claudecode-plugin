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
| **NeatContext** | Reusing knowledge in fresh sessions or across a team | A lite context generated for you:<ul><li><strong>1 domain profile:</strong> your team's rules that guide LLM behavior.</li><li><strong>1 knowledge folder:</strong> TSGs, runbooks, and other team knowledge.</li></ul> |
| **Claude Code resume** | Continuing the same conversation | The original session and its conversation history |
| **Save or export a conversation** | Keeping a record | The raw transcript, including the back-and-forth that led to the result |

> **Need enterprise-level context?** Use
> [NeatContext Desktop](https://www.neatcontext.com) to create a standard
> context. Each standard context has one domain profile, multiple knowledge
> folders, and extensions that connect to internal and external systems.

NeatContext does not copy the whole conversation. It keeps what will help Claude
work accurately next time, without carrying over the entire chat.

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

## Quick start: continue this conversation later

When an existing conversation contains work you want to keep, save it as a lite
context:

```text
You: We have finished planning the checkout retry changes. Save this work for
     the next session.

You: /neatcontext:save checkout-retry

Claude:
Lite context folder: <folder>
Profile path: <folder>/profile.md
Knowledge folder: <folder>/knowledge
Use command: /neatcontext:use checkout-retry
```

The saved context keeps the useful conclusions, decisions, current state, and
next steps—not the raw conversation. It is not connected automatically.

Later, in a new Claude Code session:

```text
You: /neatcontext:use checkout-retry

Claude: Connected to checkout-retry.

You: Continue the checkout retry work. What should I implement next?

Claude: Based on the saved context, the next step is to update the retry policy
        and add coverage for the agreed failure cases.
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

- **Lite contexts** have one domain profile and one knowledge folder, with no
  extensions. They work locally without NeatContext Desktop. Create them from a
  conversation with `/neatcontext:save`, from an existing knowledge folder with
  `/neatcontext:create`, or from a shared bundle with `/neatcontext:import`.
- **Standard contexts** have one domain profile and support multiple indexed
  knowledge folders and extensions. They are created and managed in
  [NeatContext Desktop](https://www.neatcontext.com), which must be open while
  you use them.

## License

MIT — see [LICENSE](LICENSE).
