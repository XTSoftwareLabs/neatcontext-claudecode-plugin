// UserPromptSubmit hook: injects the connected NeatContext context as pointer
// text before each prompt, so Claude Code answers grounded in it.
//
// Contract: whatever this prints to stdout is added to the model's context.
// It therefore prints *only* when a context is connected, and never throws or
// blocks the prompt — any failure exits cleanly with no output.

import { connect } from "./companion-client.mjs";

async function main() {
  const client = await connect({ timeoutMs: 2500 });
  if (!client) {
    return; // NeatContext not running: inject nothing.
  }
  try {
    const result = await client.getDocument({ timeoutMs: 2500 });
    if (result.status === 200 && typeof result.json?.document === "string") {
      process.stdout.write(result.json.document);
    }
  } catch {
    // Unreachable/slow: inject nothing rather than delay the prompt.
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
