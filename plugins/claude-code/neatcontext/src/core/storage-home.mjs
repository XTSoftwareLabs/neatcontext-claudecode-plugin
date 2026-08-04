import { homedir } from "node:os";
import path from "node:path";

// One local root for Context bundles, routing, and per-session selection. Tests
// and embedders may isolate it without changing the user's home directory.
export function neatContextHome() {
  const override = process.env.NEATCONTEXT_HOME;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(homedir(), ".neatcontext");
}
