import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  configure,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";
import type { JSXElementConstructor, ReactNode } from "react";
import { afterEach, vi } from "vitest";

type Wrapper = JSXElementConstructor<{ children: ReactNode }>;

// Every component may read the Locale, so each test renders inside an `en` IntlProvider, around
// the test's own wrapper if it passes one.
vi.mock("@testing-library/react", async (importOriginal) => {
  const rtl = await importOriginal<typeof import("@testing-library/react")>();
  const { createElement } = await import("react");
  const { IntlProvider } = await import("use-intl");
  const messages = await (await import("@path/i18n")).loadMessages("en");
  const withIntl = <T extends { wrapper?: Wrapper }>(options?: T) => ({
    ...options,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(IntlProvider, {
        locale: "en",
        messages,
        children: options?.wrapper ? createElement(options.wrapper, null, children) : children,
      }),
  });
  return {
    ...rtl,
    render: ((ui: ReactNode, options?: RenderOptions) =>
      rtl.render(ui, withIntl(options))) as typeof rtl.render,
    renderHook: ((hook: (props: unknown) => unknown, options?: RenderHookOptions<unknown>) =>
      rtl.renderHook(hook, withIntl(options))) as typeof rtl.renderHook,
  };
});

// Give async UI waits (`waitFor`, `findBy*`) more headroom than the 1000ms default. The `<App>`
// suites drive multi-step async chains (lease acquire → import → save → PUT); on a starved 2-core
// CI runner, where these tests share cores with the engine/server suites, a single 1s poll window
// can expire before a mocked PUT is even recorded — a green-local, red-CI flake (e.g.
// lease-and-save "saves through PUT with the If-Match ETag …" asserting `calls.put` has length 1).
// The `testTimeout` in `vite.config.ts` is raised to sit above this.
configure({ asyncUtilTimeout: 5000 });

// Unmount every rendered tree after each test. Testing Library auto-registers this when it detects
// a global `afterEach`, but registering it explicitly here makes the teardown order deterministic —
// the many `<App>`-rendering suites share one jsdom per worker, and a leaked tree would let a later
// test's global `screen` query match a previous test's identically-named node.
afterEach(() => {
  cleanup();
});

// jsdom does not implement `window.confirm`. The Designer asks it before discarding unsaved edits
// (New, Open…, a mode switch); default every test to "yes", and let a test that needs "no" spy on
// it.
window.confirm = () => true;
