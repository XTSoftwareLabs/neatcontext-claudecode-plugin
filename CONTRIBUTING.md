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
npm run check      # node --check on each helper script
npm test           # node --test against a fake companion API
npm run coverage   # every line you changed under scripts/ must be run by a test
```

CI (`.github/workflows/ci.yml`) runs the first two on every pull request, on
Node 18, 20 and 22 on Linux and on Node 22 on Windows, and the third once. The
single required check is `ci`, which passes only when every job did.

## Diff coverage

`npm run coverage` runs the suite and fails if any line the branch adds or
changes under `scripts/` was never executed. Whole-file coverage is not the bar
— much of this code predates the tests — but new code has to arrive with a test
that runs it.

Almost everything here is exercised the way Claude Code exercises it: the MCP
bridge and the CLI are spawned as child processes, which `node --test
--experimental-test-coverage` cannot see into. So `tools/diff-coverage.mjs` sets
`NODE_V8_COVERAGE`, which every child inherits, and merges what the whole
process tree wrote. A line counts as covered if any one process ran it.

That only works when those children exit on their own — a killed process never
flushes its profile. Tests end a bridge session by closing its stdin
(`closeSession` in `tests/fake-companion.mjs`), which is what Claude Code does
too; don't swap it back for `child.kill()`.

Please keep the plugin decoupled from NeatContext's internals: it should only
use the documented public companion API (see the README).
