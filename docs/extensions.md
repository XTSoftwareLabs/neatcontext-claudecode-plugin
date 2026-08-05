# Context extensions

A context is a domain profile plus a folder of local knowledge. Some domains
also need to reach a system: the incident tracker, the log store, the internal
service that knows what a customer is actually on. An extension is how a context
gets there.

Configuring one is hand work. There is no installer, no marketplace, and nothing
that writes configuration on your behalf — that is the point, and the rest of
this page explains why.

## Two halves that never meet

```
declaration          binding
in the context       in ~/.neatcontext/extensions.json
travels with it      never leaves this machine

"I expect an         "on this machine, `pagerduty`
 extension called     means: run this program,
 `pagerduty`, for     with these arguments,
 reading incidents"   and this environment"
```

A **declaration** says what capability the context wants. It is part of the
context, so it is the same on every machine the context reaches, and it is all
that a context you share with someone else carries.

A **binding** says what actually provides that capability here. It names a
program to run. It never travels.

Nothing runs until both exist. A context you were handed can declare whatever it
likes and still cannot execute anything, because the half that names a program
is the half you wrote yourself. Importing a context is safe for that reason
alone, not because anything scans it.

The plugin enforces the split rather than trusting it: a `command`, an
environment, or a token written next to a declaration is dropped when the
context is read, and dropped again when it is exported.

## Declaring what a context expects

From a connected context:

```bash
# Claude Code / GitHub Copilot
/neatcontext:extensions

# Codex
$neatcontext:extensions

# Kimi Code / pi
/neatcontext-extensions
```

That reports what the context asks for and whether this machine answers. To add
something, run the plugin's CLI directly, or ask the assistant to:

```bash
extensions add pagerduty \
  --capability "Read incidents, services, and on-call schedules." \
  --tools get_incident,list_incidents \
  --important
```

| flag | meaning |
| --- | --- |
| `--capability` | One line: what this lets the context do. This is what the model reads when deciding whether to reach for the extension. Required. |
| `--tools` | Only these tools of that extension. Omit to take whatever it offers. |
| `--important` | The context leans on this rather than merely benefiting from it. |

`extensions remove <id>` drops the declaration and leaves your binding alone.

On pi, the assistant declares one with the `neatcontext_declare_extension` tool
instead, since it writes the capability line from what you just described.

Declaring connects nothing.

## Binding one on this machine

Bindings live in a single file:

```
~/.neatcontext/extensions.json          (%USERPROFILE%\.neatcontext on Windows)
```

```json
{
  "schema": 1,
  "extensions": {
    "pagerduty": {
      "command": "node",
      "args": ["C:/tools/pagerduty-mcp/server.js"],
      "envFrom": ["PAGERDUTY_TOKEN"]
    }
  }
}
```

The key is the id the context declared. The value describes a program that
speaks MCP over stdio.

| field | meaning |
| --- | --- |
| `command` | The program to run. Required. Not run through a shell, so a path with a space in it is fine and a `&&` in it is not special. |
| `args` | Arguments, as an array. |
| `cwd` | Working directory. |
| `env` | Literal environment variables. |
| `envFrom` | Names of variables to pass through from your own environment. |
| `enabled` | Set `false` to turn it off without deleting it. |
| `allowedContexts` | Only these contexts, by name or id, may use this binding. |

The file is written `0600` when the plugin writes it. Write it yourself with the
same care: it is the file that says what may run.

### Credentials

Prefer `envFrom`. It names a variable you have already exported — from your
shell profile, a secret manager, whatever you use — and the value never lands in
a file NeatContext manages:

```bash
export PAGERDUTY_TOKEN="..."
```

```json
{ "command": "node", "args": ["server.js"], "envFrom": ["PAGERDUTY_TOKEN"] }
```

`env` takes literal values and exists for things like a region or an endpoint.
Putting a token there works and is your call; it means the token is sitting in a
file.

A spawned extension gets a small base environment — enough to find its
interpreter and a temp directory — plus exactly what its binding names. Nothing
else from your shell travels with it.

### What a binding is reachable by

A binding is available to any context that declares its id. That is what makes a
context portable: your teammate's copy declares `pagerduty` and finds your
`pagerduty` here. It also means a context someone hands you can declare an id you
have already bound, and use it.

Bind what you are comfortable exposing to any context you connect. When you want
something narrower, `allowedContexts` restricts a binding to contexts you name:

```json
{
  "command": "node",
  "args": ["server.js"],
  "allowedContexts": ["Payments Runbooks"]
}
```

## What the session sees

Once both halves exist, the connected context's tools appear beside
`get_context`, named `<extension>__<tool>`:

```
pagerduty__get_incident
pagerduty__list_incidents
```

They belong to the context, not the session. Switch context and they are gone —
the connections close, the tool list changes, and a call to one of them is
refused.

`get_context` reports every declaration whichever way it went:

| status | meaning |
| --- | --- |
| `ready` | Bound, running, and the tools are listed. |
| `not configured on this machine` | No binding, or it is disabled, or `allowedContexts` excludes this context. |
| `unavailable` | Bound, but it would not start — or it offers none of the tools this context asked for. |
| `failed` | It was working and then a call broke it. |

That reporting is the point. A session that cannot reach PagerDuty should say
so, not invent an incident.

## When something is wrong

`extensions test <id>` starts one extension on purpose and names the tools it
really offers, which is what you want when a declaration and a server disagree
about a name.

- **not configured** — the report prints the exact binding to paste, and where
  the file goes.
- **could not start** — check `command` and `args`. It is run without a shell,
  so `~` is not expanded and a shell alias will not be found.
- **did not answer** — the server started but never completed the MCP handshake.
  Run it by hand and see what it prints.
- **offers none of the tools this context asked for** — the names in `--tools`
  do not match. `extensions test` lists the real ones.
- **failed** — the server accepted a call and errored. The reason is passed
  through as the extension gave it.

An extension that stopped is started again on the next tool list. One that never
started is left alone for a while first, so a typo in a path does not spawn a
process on every turn.

## The context still works

None of this is load-bearing. A context whose extensions are all unconfigured,
unavailable, or broken still serves its domain profile and its knowledge folder,
and still answers. Extensions are an addition to grounding, and their absence is
reported rather than raised.
