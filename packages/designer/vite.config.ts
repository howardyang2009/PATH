/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { consoleConfig } from "../../vite.base.js";

const baseConfig = consoleConfig("/designer/");

export default defineConfig({
  ...baseConfig,
  // The Designer is mounted at `/designer/` on `path-server` (ADR 0027), a peer of the Viewer's
  // `/viewer/`, so every bundle URL is absolute from that mount root.
  plugins: [react()],
  test: {
    ...baseConfig.test,
    // Build one jsdom environment per worker and reuse it across that worker's files, instead of
    // one per file. Per-file module isolation is kept, so this is not the same trade as `isolate:
    // false`.
    pool: "vmThreads",
    // Sit above the 5000ms testing-library `asyncUtilTimeout` set in `test/setup.ts`, so a slow
    // async wait on a starved CI runner fails with its own assertion before vitest's test timeout
    // trips.
    testTimeout: 15000,
  },
});
