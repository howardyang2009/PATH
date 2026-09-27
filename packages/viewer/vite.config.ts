/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { consoleConfig } from "../../vite.base.mjs";

const baseConfig = consoleConfig("/viewer/");

export default defineConfig({
  ...baseConfig,
  // The Viewer is mounted at `/viewer/` on `path-server` (ADR 0027). `path-server` 302-redirects
  // bare `/` to `/viewer/`.
  plugins: [react()],
  test: {
    ...baseConfig.test,
    // Not `vmThreads`: that pool would build one jsdom per worker, but the live-stream tests push
    // frames through a `ReadableStream` built in `@path/client-core/test-utils`, and under
    // `node:vm` those events never reach the component. `threads` keeps them green.
    pool: "threads",
    // Under `pnpm -r run test` the suites share the machine, which pushes slow cases past vitest's
    // 5000ms default.
    testTimeout: 20000,
  },
});
