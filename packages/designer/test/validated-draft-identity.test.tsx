import { STEP_ROOTS } from "@path/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type EditKey, editKey } from "../src/edit-key.js";
import {
  type DraftResult,
  useDraft,
  useKeyedRows,
  useValidatedDraft,
} from "../src/validated-draft.js";

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

/**
 * A structured draft — the `ConditionField` shape — over the protocol's core rather than over text: the
 * draft is what the author typed, the committed value is the validated form of it.
 */
function StructuredField({
  owner,
  onCommit,
}: {
  owner: string;
  onCommit: (value: string, key?: EditKey) => void;
}): JSX.Element {
  const { draft, error, onEdit } = useDraft<string, string>(
    () => `seeded-${owner}`,
    (next) =>
      next.length < 3
        ? { ok: false, error: "Too short." }
        : { ok: true, value: next.toUpperCase() },
    editKey(owner, "when"),
    onCommit,
  );
  return (
    <>
      <input
        aria-label="structured"
        value={draft}
        onChange={(e) => onEdit(e.target.value, editKey(owner, "when"))}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

function RowsField({
  owner,
  onCommit,
}: {
  owner: string;
  onCommit: (map: Record<string, string>, key?: EditKey) => void;
}): JSX.Element {
  const { rows, setRow } = useKeyedRows(
    () => [{ key: "k", value: owner }],
    STEP_ROOTS,
    editKey(owner, "publish"),
    onCommit,
  );
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

describe("useDraft — the core, over a structured draft", () => {
  it("holds an invalid draft, shows its message, and commits nothing", () => {
    const committed: string[] = [];
    render(<StructuredField owner="a" onCommit={(value) => committed.push(value)} />);

    fireEvent.change(screen.getByLabelText("structured"), { target: { value: "ab" } });

    expect((screen.getByLabelText("structured") as HTMLInputElement).value).toBe("ab");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short.");
    expect(committed).toEqual([]);
  });

  it("commits the validated value, not the draft, and carries the edit's fold key", () => {
    const committed: { value: string; key?: EditKey }[] = [];
    render(<StructuredField owner="a" onCommit={(value, key) => committed.push({ value, key })} />);

    fireEvent.change(screen.getByLabelText("structured"), { target: { value: "abc" } });

    expect(committed).toEqual([{ value: "ABC", key: { owner: "a", field: "when" } }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-seeds the structured draft when the identity changes", () => {
    const { rerender } = render(<StructuredField owner="a" onCommit={() => {}} />);
    fireEvent.change(screen.getByLabelText("structured"), { target: { value: "typed" } });

    rerender(<StructuredField owner="b" onCommit={() => {}} />);

    expect((screen.getByLabelText("structured") as HTMLInputElement).value).toBe("seeded-b");
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
