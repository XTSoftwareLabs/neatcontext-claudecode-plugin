import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const CANONICAL_REPOSITORY = "https://github.com/XTSoftwareLabs/neatcontext-plugins";
const USER_ONLY_COMMANDS = ["create", "delete", "import", "mode", "save", "use"];

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
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );
}

test("marketplace metadata is complete, canonical, and version-aligned", async () => {
  const [pluginText, marketplaceText, packageText, bridgeText, readme] = await Promise.all([
    read(".claude-plugin/plugin.json"),
    read(".claude-plugin/marketplace.json"),
    read("package.json"),
    read("src/claude/mcp-bridge.mjs"),
    read("README.md")
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
    source: "url",
    url: `${CANONICAL_REPOSITORY}.git`,
    ref: `v${plugin.version}`
  });
  assert.equal(plugin.license, "MIT");
  assert.equal(entry.license, "MIT");
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
});

test("commands pre-approve only the bundled CLI and never interpolate arguments into shell", async () => {
  const commandNames = ["create", "delete", "import", "list", "mode", "save", "status", "use"];

  for (const name of commandNames) {
    const file = `commands/${name}.md`;
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

test("commands with side effects can only be invoked explicitly by the user", async () => {
  for (const name of USER_ONLY_COMMANDS) {
    const file = `commands/${name}.md`;
    const frontmatter = parseFrontmatter(await read(file), file);
    assert.equal(
      frontmatter["disable-model-invocation"],
      "true",
      `${file} must set disable-model-invocation: true`
    );
  }
});
