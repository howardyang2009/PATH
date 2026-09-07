// A pass-through wrapper around `better-sqlite3` that records every open handle on a global registry so
// the leak guard (`better-sqlite3-leak-guard.ts`) can assert none survive a test. `vitest.config.ts`
// aliases the bare `better-sqlite3` specifier to this file, so every import — the engine's own store and
// the tests' raw read handles alike — is tracked.
//
// Why this exists (issue #436): `better-sqlite3` is a native addon. Its per-`Database` environment cleanup
// hook (`node::RemoveEnvironmentCleanupHook`, a `CHECK`) is removed at `.close()`. A handle left open past a
// test finalizes late — during worker/process teardown, on an already-dead V8 environment — and the check
// aborts the worker with a non-zero exit *after every test has passed*: a green run, a red CI job, green on
// rerun. The `forks`/`singleFork` pool (see `vitest.config.ts`) makes that teardown a single clean process
// exit, which mitigates the race; the per-test leak guard removes it at the source by catching an unclosed
// handle the instant the leaking *test* ends, deterministically and locally.
//
// The per-test guard has one blind spot, and it is the one that still aborted CI on #442: a handle opened
// *outside* a test's own lifecycle — module scope, a `beforeAll` fixture — is not a per-test leak, and the
// guard clears its registry every `afterEach`, so nothing ever closes such a handle. Its `Statement`/
// `Database` finalizer then runs at the fork's own exit, on a dead isolate, and aborts with
// `Assertion failed: (env) != nullptr`. The `beforeExit` hook below is the backstop: it closes every handle
// still open when the fork's event loop drains — while the isolate is still live — so no open native handle
// ever reaches V8 teardown, whatever scope opened it.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The real module, resolved through node (which ignores vitest's resolve.alias), so this does not loop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Real = require("better-sqlite3") as any;

export interface TrackedHandle {
  db: { open: boolean; close(): void };
  stack: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = globalThis as unknown as {
  __betterSqliteLive?: TrackedHandle[];
  __betterSqliteAll?: TrackedHandle[];
  __betterSqliteExitHook?: boolean;
};
// `live` is the per-test view the leak guard reads and clears each `afterEach`. `all` is a never-cleared
// master list the `beforeExit` backstop drains, so a handle the per-test guard's clearing dropped is still
// closed before the fork exits.
const live: TrackedHandle[] = (registry.__betterSqliteLive ??= []);
const all: TrackedHandle[] = (registry.__betterSqliteAll ??= []);

if (!registry.__betterSqliteExitHook) {
  registry.__betterSqliteExitHook = true;
  // One hook per fork, installed on first import. `beforeExit` fires while the isolate is still live, so
  // `.close()` here removes the native cleanup hook cleanly — the abort at teardown becomes impossible.
  process.once("beforeExit", () => {
    for (const handle of all) {
      try {
        if (handle.db.open) handle.db.close();
      } catch {
        // Already closing or closed — nothing to do.
      }
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrackedDatabase(this: unknown, ...args: any[]) {
  const instance = new Real(...args);
  const handle: TrackedHandle = { db: instance, stack: new Error().stack ?? "" };
  live.push(handle);
  all.push(handle);
  return instance;
}
// Share the real prototype (so `instanceof` and every method work) and inherit the statics
// (`SqliteError`, etc.) through the constructor's own prototype chain.
TrackedDatabase.prototype = Real.prototype;
Object.setPrototypeOf(TrackedDatabase, Real);

export default TrackedDatabase;
