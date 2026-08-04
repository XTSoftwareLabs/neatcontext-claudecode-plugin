import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const CANONICAL_REPOSITORY = "https://github.com/XTSoftwareLabs/neatcontext-plugins";
const CLAUDE_PLUGIN_ROOT = "plugins/claude-code/neatcontext";
const USER_ONLY_COMMANDS = [
  "create",
  "delete",
  "disconnect",
  "export",
  "import",
  "mode",
  "save",
  "use"
];

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), "utf8");
}

function parseFrontmatter(markdown, file) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  assert.ok(normalized.startsWith("---\n"), `${file} must start with YAML frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  assert.notEqual(end, -1, `${file} must close its YAML frontmatter`);

  return Object.fromEntries(
    normalized
      .slice(4, end)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        assert.notEqual(separator, -1, `${file} has an invalid frontmatter line: ${line}`);
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        // This splitter is not a YAML parser, so it happily accepts frontmatter
        // the host then fails to load — and a command whose frontmatter does not
        // parse loads with *every* field silently dropped, including the tool
        // grant. `claude plugin validate --strict` in CI is the authority; this
        // catches the shape that actually slipped through: a value opening a
        // flow sequence has to be one well-formed sequence, so an unquoted
        // "[name] [folder]" is caught here rather than three minutes later.
        if (value.startsWith("[")) {
          assert.ok(
            value.endsWith("]") && !value.slice(1, -1).includes("["),
            `${file}: ${key} is not valid YAML — quote it as "${value}"`
          );
        }
        return [key, value];
      })
  );
}

test("marketplace metadata is complete, canonical, and version-aligned", async () => {
  const [pluginText, marketplaceText, packageText, bridgeText, readme, privacy] =
    await Promise.all([
    read(`${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`),
    read(".claude-plugin/marketplace.json"),
    read("package.json"),
    read(`${CLAUDE_PLUGIN_ROOT}/src/claude/mcp-bridge.mjs`),
    read("README.md"),
    read("PRIVACY.md")
  ]);
  const plugin = JSON.parse(pluginText);
  const marketplace = JSON.parse(marketplaceText);
  const packageJson = JSON.parse(packageText);
  const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);

  assert.ok(entry, "marketplace.json must list the plugin manifest name");
  assert.equal(plugin.displayName, "NeatContext");
  assert.equal(plugin.repository, CANONICAL_REPOSITORY);
  assert.equal(plugin.homepage, CANONICAL_REPOSITORY);
  assert.equal(packageJson.repository.url, `${CANONICAL_REPOSITORY}.git`);
  assert.equal(entry.repository, CANONICAL_REPOSITORY);
  assert.equal(entry.homepage, CANONICAL_REPOSITORY);
  assert.deepEqual(entry.source, {
    source: "git-subdir",
    url: `${CANONICAL_REPOSITORY}.git`,
    path: CLAUDE_PLUGIN_ROOT,
    ref: `v${plugin.version}`
  });
  assert.equal(plugin.license, "MIT");
  assert.equal(entry.license, "MIT");
  assert.equal(
    plugin.hooks,
    undefined,
    "hooks/hooks.json is auto-discovered; declaring the default path loads it twice"
  );
  assert.equal(plugin.version, packageJson.version);
  assert.match(
    bridgeText,
    new RegExp(`SERVER_INFO = \\{ name: "neatcontext", version: "${plugin.version.replaceAll(".", "\\.")}" \\}`)
  );
  assert.match(
    readme,
    /claude plugin marketplace add https:\/\/github\.com\/XTSoftwareLabs\/neatcontext-plugins\.git/
  );
  assert.match(readme, /claude plugin install neatcontext@neatcontext --scope user/);
  assert.doesNotMatch(readme, /XTSoftwareLabs\/neatcontext-claudecode-plugin/);
  assert.match(readme, /^## Security and data handling$/m);
  assert.match(readme, /\[Privacy Policy\]\(PRIVACY\.md\)/);
  assert.match(privacy, /^# Privacy Policy$/m);
  assert.match(privacy, /do not send telemetry, analytics, crash reports/);
});

test("commands pre-approve only the bundled CLI and never interpolate arguments into shell", async () => {
  const commandNames = [
    "create",
    "delete",
    "disconnect",
    "export",
    "extensions",
    "import",
    "list",
    "mode",
    "save",
    "status",
    "use"
  ];

  for (const name of commandNames) {
    const file = `${CLAUDE_PLUGIN_ROOT}/commands/${name}.md`;
    const markdown = await read(file);
    const frontmatter = parseFrontmatter(markdown, file);

    assert.ok(
      frontmatter["allowed-tools"]?.includes(
        'Bash(node "${CLAUDE_PLUGIN_ROOT}/src/claude/neatcontext-cli.mjs":*)'
      ),
      `${file} must limit its Node.js grant to the bundled CLI`
    );
    assert.doesNotMatch(
      frontmatter["allowed-tools"],
      /Bash\(node:\*\)/,
      `${file} must not grant arbitrary Node.js execution`
    );
    assert.doesNotMatch(
      markdown,
      /!`[^\r\n`]*\$ARGUMENTS/,
      `${file} must not substitute user arguments into a preprocessing shell command`
    );
  }
});

// Exec form is not a style preference. Without `args`, Claude Code runs the
// command through a shell — bash on POSIX, and PowerShell on Windows without
// Git Bash, which costs ~520 ms of interpreter startup on every turn the Stop
// hook fires. Exec form also keeps the plugin path away from a shell parser.
test("plugin hooks spawn without a shell", async () => {
  const hooks = JSON.parse(await read(`${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`));
  const entries = Object.entries(hooks.hooks);
  assert.deepEqual(
    entries.map(([event]) => event).sort(),
    ["PreCompact", "SessionStart", "Stop"],
    "hooks.json must register exactly the SessionStart, Stop and PreCompact events"
  );

  for (const [event, matchers] of entries) {
    for (const hook of matchers.flatMap((matcher) => matcher.hooks)) {
      assert.equal(hook.type, "command", `${event} hook must be a command hook`);
      assert.equal(hook.command, "node", `${event} hook must exec node directly, not via a shell`);
      assert.ok(Array.isArray(hook.args), `${event} hook must pass its script in args (exec form)`);
      assert.equal(hook.args.length, 1, `${event} hook takes exactly one script argument`);

      // The placeholder is substituted per-element by the host, so the entry
      // must be exactly that and nothing a shell would need to unquote.
      const [script] = hook.args;
      const prefix = "${CLAUDE_PLUGIN_ROOT}/";
      assert.ok(script.startsWith(prefix), `${event} hook script must be plugin-root relative`);
      assert.doesNotMatch(script, /["'`]/, `${event} hook script must carry no quoting`);
      await read(`${CLAUDE_PLUGIN_ROOT}/${script.slice(prefix.length)}`);
    }
  }
});

test("commands with side effects can only be invoked explicitly by the user", async () => {
  for (const name of USER_ONLY_COMMANDS) {
    const file = `${CLAUDE_PLUGIN_ROOT}/commands/${name}.md`;
    const frontmatter = parseFrontmatter(await read(file), file);
    assert.equal(
      frontmatter["disable-model-invocation"],
      "true",
      `${file} must set disable-model-invocation: true`
    );
  }
});
