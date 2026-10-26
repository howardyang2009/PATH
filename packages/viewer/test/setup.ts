import "@testing-library/jest-dom/vitest";
import type { RenderHookOptions, RenderOptions } from "@testing-library/react";
import type { JSXElementConstructor, ReactNode } from "react";
import { vi } from "vitest";

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
