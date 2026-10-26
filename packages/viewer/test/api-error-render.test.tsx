import { PathApiError } from "@path/client-core";
import { loadMessages } from "@path/i18n";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/load-state.js";
import { PaneError } from "../src/pane-note.js";

async function renderIn(locale: "de" | "en", error: unknown): Promise<HTMLElement> {
  const messages = await loadMessages(locale);
  render(
    <IntlProvider locale={locale} messages={messages}>
      <PaneError what="runs" message={errorMessage(error)} />
    </IntlProvider>,
  );
  return screen.getByRole("alert");
}

describe("a server refusal as the UI shows it", () => {
  const refusal = new PathApiError(404, 'no run found with id "r1"', undefined, "run.not-found", {
    rootRunId: "r1",
  });

  it("renders a known code in German", async () => {
    expect(await renderIn("de", refusal)).toHaveTextContent("Kein Lauf mit der ID „r1“ gefunden");
  });

  it("renders the same code in English", async () => {
    expect(await renderIn("en", refusal)).toHaveTextContent('no run found with id "r1"');
  });

  it("falls back to the English message for a code the client does not know", async () => {
    const unknown = new PathApiError(409, "a refusal from a newer server", undefined, "run.newer");
    expect(await renderIn("de", unknown)).toHaveTextContent("a refusal from a newer server");
  });
});
