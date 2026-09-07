import { defineConfig } from "vitest/config";

/**
 * Run the engine's tests in the **forks** pool (a child process, not a worker thread), and in a
 * **single** long-lived fork.
 *
 * The engine's store is `better-sqlite3`, a native addon. Its environment-cleanup hook
 * (`node::RemoveEnvironmentCleanupHook`, a `CHECK`) fires whenever the runtime that loaded the addon
 * is torn down. In vitest's default `threads` pool that teardown is a worker *thread*, and the hook
 * asserts on a null env and aborts the worker with a non-zero exit *after every test has passed* — a
 * green run, a red job. The `forks` pool moved that teardown onto a child *process*, which the switch
 * below already fixed for the thread variant.
 *
 * But with per-file isolation the pool spawns and **tears down one fork per test file** (dozens of
 * them). Every one of those teardowns runs the native cleanup hook, so on a busy CI runner one of
 * them still aborts intermittently — the job goes red with `Error: Worker exited unexpectedly` from
 * tinypool, always at teardown, never a failed assertion, and always green on rerun. `singleFork`
 * runs all of the engine's test files sequentially in **one** fork, so the native cleanup hook runs
 * exactly once, on a clean process exit, instead of dozens of times under pool churn. The engine's
 * tests already isolate their own state in per-test temp dirs and stores, so they do not rely on the
 * per-file process isolation this drops.
 */
export default defineConfig({
  // Route every `better-sqlite3` import through a tracking wrapper so the leak guard below can catch a
  // handle a test forgot to close — the source of the #436 teardown crash. The wrapper is a faithful
  // pass-through (same prototype and statics); it only records open handles on a global registry.
  resolve: {
    alias: {
      "better-sqlite3": new URL("./test/support/better-sqlite3-tracked.ts", import.meta.url).pathname,
    },
  },
  test: {
    // Fail a test loudly and locally if it leaves a better-sqlite3 handle open, rather than letting the
    // handle finalize late during teardown and abort the worker as a green-run/red-job CI flake (#436).
    setupFiles: ["./test/support/better-sqlite3-leak-guard.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        // `--expose-gc` gives the leak guard's `afterAll` a `global.gc()` to force every better-sqlite3
        // `Statement` wrapper to finalize on a live isolate, before teardown. Without it that finalize is
        // deferred to V8 teardown and aborts the fork — a green run, a red job (#436, #442).
        execArgv: ["--expose-gc"],
      },
    },
  },
});
