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
  it("offers every folder the Server lists, an empty one included", async () => {
    const messages = await loadMessages("en");
    render(
      <IntlProvider locale="en" messages={messages}>
        <SaveTemplateAsDialog
          source={null}
          templateList={{
            phase: "ready",
            templates: [],
            roots: [
              { origin: "user", relative_path: "users/local/template", folders: ["empty"] },
              { origin: "shared", relative_path: "shared/template", folders: ["team"] },
            ],
            maxFileBytes: null,
          }}
          create={async () => ({ status: "created", path: null })}
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </IntlProvider>,
    );
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["(my templates)", "empty", "(shared templates)", "shared/team"]);
  });

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
