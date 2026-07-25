# Contributing

Thanks for helping improve the NeatContext Claude Code plugin.

## Branching & review

- `main` is protected. All changes land through a pull request.
- A pull request must be **approved by a collaborator** before it can merge.
- **CI must pass before a pull request can merge.**
- Collaborators may bypass the checks and merge when appropriate.

## Commit messages

- Write plain, descriptive commit messages focused on the change.
- **Do not add AI-assistant attribution trailers** (for example
  `Co-Authored-By: Claude ...` or "Generated with ..." footers). Keep the
  history free of tooling attribution.

## Local checks

The plugin is dependency-free. Before opening a PR, sanity-check the scripts:

```bash
npm run check   # node --check on each helper script
npm test        # node --test against a fake companion API
```

CI (`.github/workflows/ci.yml`) runs both on every pull request, on Node 18, 20
and 22 on Linux and on Node 22 on Windows. The single required check is `ci`,
which passes only when every matrix job did.

Please keep the plugin decoupled from NeatContext's internals: it should only
use the documented public companion API (see the README).
