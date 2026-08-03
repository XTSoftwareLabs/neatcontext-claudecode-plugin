// The shared evidence projector is authored once and packaged into every host
// plugin. Installed plugins cannot import outside their own directory, so the
// repository commits generated copies and this script keeps them identical.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "shared", "core", "conversation-evidence.mjs");
const targets = [
  "plugins/claude-code/neatcontext/src/core/conversation-evidence.mjs",
  "plugins/kimi-code/neatcontext/src/core/conversation-evidence.mjs",
  "plugins/pi/neatcontext/src/core/conversation-evidence.mjs",
  "codex-marketplace/plugins/neatcontext/src/core/conversation-evidence.mjs"
].map((relative) => path.join(root, ...relative.split("/")));

const check = process.argv.includes("--check");
const canonical = await readFile(source, "utf8");
const stale = [];

for (const target of targets) {
  if (check) {
    const packaged = await readFile(target, "utf8").catch(() => null);
    if (packaged !== canonical) stale.push(path.relative(root, target));
    continue;
  }
  await writeFile(target, canonical, "utf8");
}

if (stale.length > 0) {
  throw new Error(
    `Packaged conversation evidence is stale: ${stale.join(", ")}. ` +
      "Run `npm run sync:evidence`."
  );
}

if (!check) {
  process.stdout.write(`Synced conversation evidence into ${targets.length} host plugins.\n`);
}
