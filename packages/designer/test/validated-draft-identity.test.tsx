import { STEP_ROOTS } from "@path/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { editKey, type EditKey } from "../src/edit-key.js";
import { useKeyedRows, useValidatedDraft, type DraftResult } from "../src/validated-draft.js";

/**
 * The draft protocol's own seam: the identity a field passes is what re-seeds it, so a caller can no
 * longer forget the React `key` that used to be the only thing making the reset happen (#389). These
 * drive the hooks directly, with an identity the test changes the way the pane changes node.
 */

function DraftField({ owner }: { owner: string }): JSX.Element {
  const { draft, onEdit } = useValidatedDraft(
    () => `seeded-${owner}`,
    (text): DraftResult<string> => ({ ok: true, value: text }),
    editKey(owner, "name"),
    () => {},
  );
  return <input aria-label="draft" value={draft} onChange={(e) => onEdit(e.target.value)} />;
}

function RowsField({ owner, onCommit }: { owner: string; onCommit: (map: Record<string, string>, key?: EditKey) => void }): JSX.Element {
  const { rows, setRow } = useKeyedRows(() => [{ key: "k", value: owner }], STEP_ROOTS, editKey(owner, "publish"), onCommit);
  return (
    <button type="button" onClick={() => setRow(0, { key: "k", value: "edited" })}>
      {rows.map((row) => `${row.key}=${row.value}`).join(",")}
    </button>
  );
}

describe("useValidatedDraft — the identity re-seeds the draft", () => {
  it("shows the new owner's draft when the identity changes, with no React key involved", () => {
    const { rerender } = render(<DraftField owner="a" />);
    const draft = screen.getByLabelText("draft") as HTMLInputElement;
    expect(draft.value).toBe("seeded-a");

    fireEvent.change(draft, { target: { value: "typed" } });
    expect(draft.value).toBe("typed");

    // The pane's node selection changes: the field must show the new node's text, not the typed draft.
    rerender(<DraftField owner="b" />);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("seeded-b");

    // Returning re-seeds from the source too, rather than remembering the abandoned edit.
    rerender(<DraftField owner="a" />);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("seeded-a");
  });
});

describe("useKeyedRows — the identity scopes the rows and their fold", () => {
  it("re-seeds the row list when its identity changes", () => {
    const { rerender } = render(<RowsField owner="a" onCommit={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("k=a");

    rerender(<RowsField owner="b" onCommit={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("k=b");
  });

  it("commits a row edit under the list's identity plus the row index, so rows cannot fold together", () => {
    const committed: { map: Record<string, string>; key?: EditKey }[] = [];
    render(<RowsField owner="a" onCommit={(map, key) => committed.push({ map, key })} />);

    fireEvent.click(screen.getByRole("button"));

    expect(committed).toHaveLength(1);
    expect(committed[0]!.map).toEqual({ k: "edited" });
    expect(committed[0]!.key).toEqual({ owner: "a", field: "publish", row: 0 });
  });
});
