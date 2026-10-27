import { verbatim } from "@path/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditingToolbar, FileStatus } from "../src/editing-toolbar.js";
import type { EditorChrome } from "../src/editor-chrome.js";
import type { SaveState } from "../src/use-open-file.js";

const noop = (): void => {};

function status(saveState: SaveState): HTMLElement {
  render(<FileStatus frame={undefined} saveState={saveState} onReload={noop} />);
  return screen.getByRole(saveState.phase === "saved-as-template" ? "status" : "alert");
}

function toolbar(lease: EditorChrome["lease"]): void {
  const chrome: EditorChrome = {
    save: true,
    saveLabel: { key: "designer.editingToolbar.save" },
    busy: false,
    saveAs: true,
    undo: true,
    redo: true,
    remove: true,
    download: true,
    lease,
  };
  render(
    <EditingToolbar
      chrome={chrome}
      onNew={noop}
      onOpen={noop}
      onUndo={noop}
      onRedo={noop}
      onSave={noop}
      onSaveAs={noop}
      onDelete={noop}
      onDownload={noop}
      onUpload={noop}
      onTakeover={noop}
      onReacquire={noop}
    />,
  );
}

describe("FileStatus in en", () => {
  it("names the stale-write conflict and offers a reload", () => {
    expect(status({ phase: "conflict", message: verbatim("changed") })).toHaveTextContent(
      "Save refused: this file changed on disk since you opened itReload file",
    );
  });

  it("renders a save refusal's message, its own or the Server's", () => {
    expect(
      status({ phase: "error", message: { key: "designer.document.readOnly" } }),
    ).toHaveTextContent("Could not save: Read-only: only the creator can save. Use Save as.");
  });

  it("renders a delete refusal with the Server's words", () => {
    const alert = status({ phase: "delete-error", message: verbatim("gone") });
    expect(alert).toHaveTextContent("Could not delete: gone");
    expect(alert).toHaveAttribute("title", "gone");
  });

  it("confirms a save as template", () => {
    expect(status({ phase: "saved-as-template", name: "fetch" })).toHaveTextContent(
      'Saved as template "fetch"',
    );
  });
});

describe("EditingToolbar in en", () => {
  it("counts down another session's lease", () => {
    toolbar({ phase: "held-by-other", expiresAt: new Date(Date.now() + 30_000).toISOString() });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^Another session is editing this file — its lease expires in \d+s\.Take over$/,
    );
  });

  it("names a lost lease", () => {
    toolbar({ phase: "lost" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Editing lease lost. Another session may have taken over, or your lease expired.Re-acquire",
    );
  });

  it("titles Undo and Redo with their shortcuts", () => {
    toolbar(undefined);
    expect(screen.getByRole("button", { name: "Undo" }).title).toMatch(/^Undo \((⌘Z|Ctrl\+Z)\)$/);
    expect(screen.getByRole("button", { name: "Redo" }).title).toMatch(/^Redo \((⇧⌘Z|Ctrl\+Y)\)$/);
  });
});
