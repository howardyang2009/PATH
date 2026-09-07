import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Give async UI waits (`waitFor`, `findBy*`) more headroom than the 1000ms default. The `<App>` suites
// drive multi-step async chains (lease acquire → import → save → PUT); on a starved 2-core CI runner,
// where these tests share cores with the engine/server suites, a single 1s poll window can expire before
// a mocked PUT is even recorded — a green-local, red-CI flake (e.g. app-lease-save "saves through PUT …"
// asserting `calls.put` has length 1). The `testTimeout` in `vite.config.ts` is raised to sit above this.
configure({ asyncUtilTimeout: 5000 });

// Unmount every rendered tree after each test. Testing Library auto-registers this when it detects a
// global `afterEach`, but registering it explicitly here makes the teardown order deterministic — the
// many `<App>`-rendering suites share one jsdom per worker, and a leaked tree would let a later test's
// global `screen` query match a previous test's identically-named node.
afterEach(() => {
  cleanup();
});
