# NeatContext for Codex

This directory is an isolated Codex marketplace. It does not modify or package
the Claude Code plugin under `plugins/claude-code/neatcontext`.

## Install locally

From the repository root:

```powershell
codex plugin marketplace add .\codex-marketplace
codex plugin add neatcontext@personal
```

Start a new Codex thread after installation. Review and trust the plugin's
`SessionStart` hook with `/hooks` when prompted.

## Skills

- `$neatcontext:save`
- `$neatcontext:use`
- `$neatcontext:disconnect`
- `$neatcontext:list`
- `$neatcontext:status`
- `$neatcontext:create`
- `$neatcontext:import`
- `$neatcontext:delete`
- `$neatcontext:mode`

The plugin shares the existing schema-1 NeatContext store by default. For
isolated development, set `NEATCONTEXT_COMPANION_FILE` to a temporary
`companion.json` path; lite contexts and routing state will be stored beside
that file.

## Verify

```powershell
node --test codex-marketplace/tests/codex-plugin.test.mjs
python "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py" `
  .\codex-marketplace\plugins\neatcontext
```
