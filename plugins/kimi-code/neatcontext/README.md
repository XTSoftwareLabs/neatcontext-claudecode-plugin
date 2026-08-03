# NeatContext for Kimi Code

Extract domain knowledge and preserve useful work from Kimi Code conversations
as structured, reusable context that you can reconnect in later sessions or
share with your team.

![NeatContext for Kimi Code demo](assets/neatcontext_kimi_code_demo.gif)

## Why NeatContext?

Domain knowledge is what helps Kimi Code work accurately in your environment:
your systems, constraints, decisions, terminology, and ways of working.

You naturally build that knowledge while debugging, planning, investigating
incidents, and implementing features with Kimi Code. Those conversations contain
discoveries that will matter again, but without a durable context they remain
trapped in one session.

NeatContext extracts the reusable knowledge from that work and saves it as a
structured context. Reconnect it when you return to the domain so Kimi Code can
start with the knowledge it needs, or share it with teammates so everyone
benefits from what one person learned.

## Install

In Kimi Code, run:

```text
/plugins install https://github.com/XTSoftwareLabs/neatcontext-plugins/tree/main
```

Then run `/reload`

## Commands

- `/neatcontext:save [name]` — save reusable work from the visible conversation.
- `/neatcontext:use [name or number]` — connect or switch this session.
- `/neatcontext:disconnect` — disconnect only this session.
- `/neatcontext:list` — list lite and standard contexts.
- `/neatcontext:status` — show the selection and routing mode.
- `/neatcontext:create` — create a lite context around an existing knowledge folder.
- `/neatcontext:import [folder]` — import a shared lite-context bundle.
- `/neatcontext:export [name] [folder]` — export a saved context as a shareable bundle.
- `/neatcontext:delete [name or number]` — preview and delete a lite context.
- `/neatcontext:mode [auto|ask|manual]` — show or change routing behavior.

Each Kimi Code session keeps its own selection. Lite contexts are fully local
and do not require the NeatContext desktop app. Standard contexts use the
desktop companion on `127.0.0.1` and can expose the extensions configured for
that context.

See the repository [Privacy Policy](../../../PRIVACY.md) for storage, network,
retention, and model-provider details.
