import { defineConfig } from "vitest/config";

/**
 * Run the engine's tests in the **forks** pool (a child process per test file), not vitest's default
 * `threads` pool. The engine's store is `better-sqlite3`, a native addon; its `Statement` finalizer
 * calls `node::RemoveEnvironmentCleanupHook`, which asserts `(env) != nullptr` during a worker *thread*
 * teardown. On CI that assertion aborts the worker with a non-zero exit *after every test has passed*,
 * so the run is green yet the job fails. A forked child exits through the normal process path, which
 * never touches that thread-teardown hook, so the native finalizer runs cleanly.
 */
export default defineConfig({
  test: {
    pool: "forks",
  },
});
