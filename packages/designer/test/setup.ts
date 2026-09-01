import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount every rendered tree after each test. Testing Library auto-registers this when it detects a
// global `afterEach`, but registering it explicitly here makes the teardown order deterministic — the
// many `<App>`-rendering suites share one jsdom per worker, and a leaked tree would let a later test's
// global `screen` query match a previous test's identically-named node.
afterEach(() => {
  cleanup();
});
