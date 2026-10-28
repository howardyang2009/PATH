import { PathApiClient } from "@path/client-core";
import { type Locale, loadMessages } from "@path/i18n";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { TopBar } from "../src/app-shell.js";
import { CancelButton } from "../src/cancel-button.js";
import { LaunchForm } from "../src/launch-form.js";

const client = new PathApiClient({ baseUrl: "", fetch: async () => new Response(null) });

async function renderIn(locale: Locale, ui: ReactNode): Promise<void> {
  const messages = await loadMessages(locale);
  render(ui, {
    wrapper: ({ children }) => (
      <IntlProvider locale={locale} messages={messages}>
        {children}
      </IntlProvider>
    ),
  });
}

describe("the Viewer in each Locale", () => {
  it.each([
    ["en", "by RheinWeg"],
    ["de", "von RheinWeg"],
    ["zh-CN", "RheinWeg 出品"],
  ] as const)("%s names RheinWeg beside the brand as %s", async (locale, text) => {
    await renderIn(locale, <TopBar sub="viewer" />);
    expect(screen.getByRole("link", { name: text })).toHaveAttribute(
      "href",
      "https://rheinwegde.de/",
    );
  });

  it.each([
    ["de", "Lauf abbrechen"],
    ["zh-CN", "取消运行"],
  ] as const)("%s shows the translated Cancel button", async (locale, label) => {
    await renderIn(locale, <CancelButton client={client} rootRunId="r1" />);
    expect(screen.getByTestId("cancel-button")).toHaveTextContent(label);
  });

  it.each([
    ["en", 1, "1 unresolved warning — the run may fail at start."],
    ["en", 2, "2 unresolved warnings — the run may fail at start."],
    ["de", 1, "1 ungelöste Warnung"],
    ["de", 2, "2 ungelöste Warnungen"],
    ["zh-CN", 2, "2 个未解决的警告"],
  ] as const)("%s pluralises %i launch warnings", async (locale, count, text) => {
    await renderIn(
      locale,
      <LaunchForm
        client={client}
        workflowPath="flow.json"
        onLaunched={() => {}}
        submitLabel="Go"
        idBase="t"
        testIdPrefix="t"
        containerTestId="t-form"
        warningCount={count}
      />,
    );
    expect(screen.getByTestId("t-warning")).toHaveTextContent(text);
  });
});
