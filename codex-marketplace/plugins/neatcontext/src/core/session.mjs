// Host session identity used by the reusable NeatContext runtime.
//
// Core modules do not know how a host names or exposes a session. A host
// adapter installs a provider before invoking the runtime. Without one, direct
// use retains the original single-session behavior.

let sessionIdProvider = () => null;

export function configureSessionId(provider) {
  if (typeof provider !== "function") {
    throw new TypeError("The session id provider must be a function.");
  }
  sessionIdProvider = provider;
}

export function sessionId() {
  const id = sessionIdProvider();
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}
