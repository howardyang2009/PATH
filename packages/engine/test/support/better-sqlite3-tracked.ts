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
// The per-test guard has a blind spot the crash on #442 lives in: better-sqlite3 registers a per-*Statement*
// native cleanup hook, removed only when the Statement's C++ wrapper is destroyed at JS GC — not at
// `db.close()`. Every `db.prepare(...)` a test ran leaves such a wrapper; if its GC is deferred, the
// destructor runs during the fork's V8 teardown, on a dead isolate, and aborts with `Assertion failed:
// (env) != nullptr` after every test passed. The guard only inspects `db.open`, so it never sees this. The
// `all` master list below feeds the leak guard's `afterAll`, which closes stragglers and forces a GC while
// the isolate is still live (see `better-sqlite3-leak-guard.ts`), so no native object is left to finalize
// at teardown.
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
};
// `live` is the per-test view the leak guard reads and clears each `afterEach`. `all` is a never-cleared
// master list the leak guard's `afterAll` drains and GCs, so a handle the per-test clearing dropped is
// still closed and finalized before the fork tears down.
const live: TrackedHandle[] = (registry.__betterSqliteLive ??= []);
const all: TrackedHandle[] = (registry.__betterSqliteAll ??= []);

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
