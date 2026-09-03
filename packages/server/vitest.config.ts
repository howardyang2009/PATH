import { defineConfig } from "vitest/config";

/**
 * Run the server's tests in the **forks** pool (a child process per test file), not vitest's default
 * `threads` pool. The server opens the engine's `better-sqlite3` store; that native addon's `Statement`
 * finalizer calls `node::RemoveEnvironmentCleanupHook`, which asserts `(env) != nullptr` during a worker
 * *thread* teardown and aborts the worker non-zero *after every test has passed* — a green run that fails
 * the job. A forked child exits through the normal process path, so the native finalizer runs cleanly.
 * Kept in step with `packages/engine/vitest.config.ts`, which shares the store and the same reason.
 */
export default defineConfig({
  test: {
    pool: "forks",
  },
});
