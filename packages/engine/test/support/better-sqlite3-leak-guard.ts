// After each test, fail if any `better-sqlite3` handle the test opened is still `.open`. A leaked handle
// finalizes late — during worker/process teardown, on a dead V8 environment — and aborts the worker with a
// non-zero exit after the tests have already passed (issue #436). This guard turns that rare, teardown-only
// CI flake into a deterministic, local failure that names the exact leaking test and where it opened the
// handle. The registry is populated by the aliased wrapper (`better-sqlite3-tracked.ts`).
//
// Registered as a `setupFiles` entry, so this `afterEach` runs after each test file's own `afterEach`
// hooks (setup hooks run outermost): a handle a test closes in its own teardown is already closed here.
import { afterEach } from "vitest";
import type { TrackedHandle } from "./better-sqlite3-tracked.js";

const registry = globalThis as unknown as { __betterSqliteLive?: TrackedHandle[] };

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
