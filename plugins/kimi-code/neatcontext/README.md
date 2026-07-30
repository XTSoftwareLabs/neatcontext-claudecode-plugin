# NeatContext for Kimi Code

Save durable knowledge from Kimi Code conversations, reconnect it in later
sessions, and route each session to the right local or desktop-backed context.

![NeatContext for Kimi Code demo](assets/neatcontext_kimi_code_demo.gif)

## Install

In Kimi Code, run:

```text
/plugins install https://github.com/XTSoftwareLabs/neatcontext-plugins/tree/main
/reload
```

Use Kimi Code 0.21.0 or newer. The plugin uses Kimi's bundled JavaScript runner,
so a separate Node.js installation is not required.

Kimi Code installs the repository-level `kimi.plugin.json`, which packages the
isolated runtime in this directory. To test a local checkout, open `/plugins`,
choose **Custom**, and install the absolute path to the repository root.

## Commands

- `/neatcontext:save [name]` — save reusable work from the visible conversation.
- `/neatcontext:use [name or number]` — connect or switch this session.
- `/neatcontext:disconnect` — disconnect only this session.
- `/neatcontext:list` — list lite and standard contexts.
- `/neatcontext:status` — show the selection and routing mode.
- `/neatcontext:create` — create a lite context around an existing knowledge folder.
- `/neatcontext:import [folder]` — import a shared lite-context bundle.
- `/neatcontext:delete [name or number]` — preview and delete a lite context.
- `/neatcontext:mode [auto|ask|manual]` — show or change routing behavior.

Each Kimi Code session keeps its own selection. Lite contexts are fully local
and do not require the NeatContext desktop app. Standard contexts use the
desktop companion on `127.0.0.1` and can expose the extensions configured for
that context.

See the repository [Privacy Policy](../../../PRIVACY.md) for storage, network,
retention, and model-provider details.
