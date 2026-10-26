import { type Locale, loadMessages } from "@path/i18n";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { SaveTemplateAsDialog } from "../src/save-template-as-dialog.js";

async function droppedNote(locale: Locale, droppedFields: string[]): Promise<HTMLElement> {
  const messages = await loadMessages(locale);
  render(
    <SaveTemplateAsDialog
      source={null}
      workflowName="main"
      droppedFields={droppedFields}
      templateList={{ phase: "loading" }}
      create={async () => ({ status: "created", path: null })}
      onCreated={() => {}}
      onCancel={() => {}}
    />,
    {
      wrapper: ({ children }) => (
        <IntlProvider locale={locale} messages={messages}>
          {children}
        </IntlProvider>
      ),
    },
  );
  return screen.getByRole("note");
}

describe("SaveTemplateAsDialog", () => {
  it.each([
    ["en", ["config"], "A template keeps only the body. config will be dropped."],
    [
      "en",
      ["config", "input"],
      "A template keeps only the body. config and input will be dropped.",
    ],
    [
      "de",
      ["config", "input", "worker_defaults"],
      "Eine Vorlage behält nur den Inhalt. config, input und worker_defaults werden verworfen.",
    ],
    ["zh-CN", ["config", "input"], "模板只保留主体。config和input 将被丢弃。"],
  ] as const)(
    "%s lists the dropped fields %j in the Locale's words",
    async (locale, fields, text) => {
      expect(await droppedNote(locale, [...fields])).toHaveTextContent(text);
    },
  );
});
