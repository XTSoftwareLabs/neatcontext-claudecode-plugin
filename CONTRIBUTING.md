# Contributing

Thanks for helping improve the NeatContext host integrations.

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
npm run check           # node --check on each host helper script
npm run validate:plugin # Claude Code marketplace validation, warnings included
npm test                # host integration tests against a fake companion API
npm run coverage        # every changed Claude-plugin source line must run in a test
```

CI (`.github/workflows/ci.yml`) runs `npm run check` and `npm test` on every
pull request, on Node 18, 20 and 22 on Linux and on Node 22 on Windows, and the
coverage and marketplace checks once each. The marketplace job installs the
current Claude Code release because Anthropic's review pipeline runs the same
validator. Run `npm run validate:plugin` locally before submission as well. The
single required check is `ci`, which passes only when every CI job did.

## Diff coverage

`npm run coverage` runs the suite and fails if any line the branch adds or
changes under the Claude plugin's `src/` directory was never executed.
Whole-file coverage is not the bar — much of this code predates the tests — but
new code has to arrive with a test that runs it. Other isolated host packages
have their own integration tests in the repository suite.

Almost everything here is exercised the way the coding hosts exercise it: the
MCP bridges and CLIs are spawned as child processes, which `node --test
--experimental-test-coverage` cannot see into. So `tools/diff-coverage.mjs` sets
`NODE_V8_COVERAGE`, which every child inherits, and merges what the whole
process tree wrote. A line counts as covered if any one process ran it.

That only works when those children exit on their own — a killed process never
flushes its profile. Tests end a bridge session by closing its stdin
(`closeSession` in `tests/fake-companion.mjs`), which is how the hosts shut down
stdio MCP servers too; don't swap it back for `child.kill()`.

The gate reads `git diff`, which does not see **untracked** files. A brand-new
script is invisible to it — and so trivially "passes" — until you `git add` it.
Stage new files before trusting a green run locally; CI diffs a pushed branch,
where everything is tracked already.

Please keep the plugin decoupled from NeatContext's internals: it should only
use the documented public companion API (see the README).

## Releases

There are two release streams, because the hosts are distributed differently.

**Claude Code, Codex, and Kimi Code** move together. Bump the version in
`package.json`, the two plugin manifests, `kimi.plugin.json`, and the `ref` in
`.claude-plugin/marketplace.json`; merge that, then tag `v<version>` and publish
a GitHub release. Marketplaces install from the tag, so the tag is the release.

**pi** is published to npm and versions independently. pi's git source clones a
repository and treats the clone root as the package — it has no subpath — so
`plugins/pi/neatcontext` is only reachable once published. To cut one:

1. Bump `version` in `plugins/pi/neatcontext/package.json` and merge it.
2. `git tag pi-v<version> && git push origin pi-v<version>`.

`.github/workflows/release-pi.yml` then verifies the tag matches package.json,
re-runs the full suite, publishes with provenance, and creates the GitHub
release. It needs an `NPM_TOKEN` repository secret with publish rights on the
`@xtsoftwarelabs` scope. Run it from the Actions tab first — a dispatched run
defaults to a dry run, which validates and packs without publishing.

Keep the two tag prefixes distinct. A `v*` tag moves the marketplace hosts and
must not move pi.

## Repository layout

The runtime is split at the host boundary:

```text
.claude-plugin/
└── marketplace.json                repository-level Claude marketplace catalog
kimi.plugin.json                    repository-level Kimi Code plugin manifest
plugins/
├── claude-code/
│   └── neatcontext/                complete installable Claude plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── commands/               Claude Code slash-command definitions
│       └── src/
│           ├── core/               reusable storage, selection, and routing logic
│           └── claude/             Claude process entry points and session adapter
├── kimi-code/
│   └── neatcontext/                complete installable Kimi Code plugin
│       ├── kimi.plugin.json
│       ├── commands/               Kimi Code slash-command definitions
│       ├── skills/                 workflows plus session-start guidance
│       └── src/
│           ├── core/               packaged copy of the reusable runtime
│           └── kimi/               Kimi process entry points and session adapter
└── pi/
    └── neatcontext/                npm-published pi package
        ├── package.json            npm manifest and pi resource manifest in one
        ├── extensions/             the pi extension: tools, commands, events
        ├── skills/                 the two workflows that need a model
        ├── src/
        │   ├── core/               packaged copy of the reusable runtime
        │   └── pi/                 in-process runtime and session adapter
        └── tests/                  this package's own integration tests
tests/                              core and host integration coverage
tools/                              development and end-to-end utilities
```

Each host plugin's `src/core/` must not import from its host directory or read
host-specific environment variables. Host integrations provide session identity
through `configureSessionId` in `src/core/session.mjs`, then call the core
operations. Keep host wording, command conventions, manifests, and process
startup in the host directory. An installed plugin cannot reach outside its own
directory, so any shared source must be packaged into each host plugin at release
time.
