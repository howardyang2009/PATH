import { defineConfig } from "vitest/config";

/**
 * The codemod tests drive the real CLI through `tsx` in a child process, so one case costs seconds.
 * Under `pnpm -r run test` six other packages share the machine, and vitest's 5000ms default leaves
 * no headroom for that: passing cases were reaching 4255ms and eight were killed at 5000ms, while
 * the package alone finishes every case well inside the default. This is the same headroom
 * `packages/designer` gives its own suite for a starved runner.
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
  },
});
