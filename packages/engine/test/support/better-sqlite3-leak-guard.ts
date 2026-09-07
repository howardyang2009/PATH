// After each test, fail if any `better-sqlite3` handle the test opened is still `.open`. A leaked handle
// finalizes late — during worker/process teardown, on a dead V8 environment — and aborts the worker with a
// non-zero exit after the tests have already passed (issue #436). This guard turns that rare, teardown-only
// CI flake into a deterministic, local failure that names the exact leaking test and where it opened the
// handle. The registry is populated by the aliased wrapper (`better-sqlite3-tracked.ts`).
//
// Registered as a `setupFiles` entry, so this `afterEach` runs after each test file's own `afterEach`
// hooks (setup hooks run outermost): a handle a test closes in its own teardown is already closed here.
import { afterAll, afterEach } from "vitest";
import type { TrackedHandle } from "./better-sqlite3-tracked.js";

const registry = globalThis as unknown as {
  __betterSqliteLive?: TrackedHandle[];
  __betterSqliteAll?: TrackedHandle[];
};

afterEach((ctx) => {
  const live = registry.__betterSqliteLive ?? [];
  const leaked = live.filter((handle) => {
    try {
      return handle.db.open;
    } catch {
      return false;
    }
  });
  // Clear for the next test whether or not any leaked — a reported leak must not re-report on later tests.
  live.length = 0;
  if (leaked.length > 0) {
    const where = leaked
      .map((handle, i) => `  handle #${i} opened at:\n${handle.stack.split("\n").slice(1, 6).join("\n")}`)
      .join("\n");
    throw new Error(
      `${leaked.length} better-sqlite3 handle(s) left open by "${ctx.task.name}" — close them (see issue #436):\n${where}`,
    );
  }
});

// The per-test guard above catches an open *Database* a test forgot to close. It does not reach the crash
// that still aborted CI on #442: better-sqlite3 registers a per-*Statement* native cleanup hook that is
// removed only when the Statement's C++ wrapper is destroyed — at JS GC, not at `db.close()`. A retained
// Statement wrapper (every `db.prepare(...)` a test ran) whose GC is deferred finalizes during the fork's
// V8 teardown, on a dead isolate, and aborts with `RemoveEnvironmentCleanupHook … Assertion failed:
// (env) != nullptr` — after every test passed. `beforeExit` cannot fix this: tinypool force-terminates the
// fork, so that hook never fires.
//
// This `afterAll` runs at each test file's end, inside the fork, while the isolate is still live. It closes
// any straggler Database, then forces a GC (vitest.config.ts passes `--expose-gc`) so every Statement
// wrapper finalizes *now*, on a live env, removing its cleanup hook cleanly. Nothing native is left to
// finalize at teardown, so the abort cannot happen.
//
// One synchronous `gc()` is not enough on a busy CI runner (the residual #442/#443 abort): better-sqlite3's
// Statement wrapper finalizes through a V8 weak-callback that `gc()` *schedules* rather than runs inline, so
// the native destructor fires on a later tick. If `afterAll` returns before that tick, the destructor can
// instead run during the fork's teardown, on a dead env, and abort. So this hook is async: after each GC it
// yields a macrotask (`setImmediate`) to let the scheduled finalizers run on the live isolate, and loops a
// few times because a wrapper freed by one cycle only becomes collectable on the next. The loop is bounded
// and cheap — a handful of GCs at each file's end — and deterministic where a single inline `gc()` raced.
afterAll(async () => {
  const all = registry.__betterSqliteAll ?? [];
  for (const handle of all) {
    try {
      if (handle.db.open) handle.db.close();
    } catch {
      // Already closing or closed.
    }
  }
  all.length = 0;
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return;
  for (let pass = 0; pass < 5; pass++) {
    gc();
    // Drain a macrotask so the weak-callback finalizers V8 just scheduled actually run before teardown.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});
