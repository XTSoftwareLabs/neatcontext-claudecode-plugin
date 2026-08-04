// Close a stdio session the same way coding hosts do. This lets child
// processes flush their V8 coverage profiles before the test continues.
export function closeSession(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }
    child.once("exit", () => resolve());
    child.stdin.end();
  });
}
