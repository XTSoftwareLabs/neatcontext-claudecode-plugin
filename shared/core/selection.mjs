import { clearSelection, writeSelection } from "./local-state.mjs";
import { listContexts } from "./context-store.mjs";

export async function listAllContexts() {
  const contexts = await listContexts();
  return { contexts };
}

export function resolveContext(contexts, query) {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) {
    const context = contexts[Number(trimmed) - 1];
    return context ? { context } : { error: "out_of_range" };
  }
  const lower = trimmed.toLowerCase();
  const exact = contexts.filter((context) => context.name.toLowerCase() === lower);
  if (exact.length === 1) {
    return { context: exact[0] };
  }
  const partial = contexts.filter((context) => context.name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { context: partial[0] };
  }
  return { error: partial.length > 1 || exact.length > 1 ? "ambiguous" : "not_found" };
}

export async function applySelection(target) {
  await writeSelection({ contextId: target.id, contextName: target.name });
  return { name: target.name };
}

export async function disconnectSelection() {
  await clearSelection();
}

export { clearSelection };
