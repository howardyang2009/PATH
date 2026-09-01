import { createContext, useContext, type ReactNode } from "react";

/**
 * The canvas selection, threaded to every block without drilling it through eight component
 * signatures (#369, designer-spec § Canvas interaction model: single-click selects). A block reads
 * whether it is the selected one and reports a single-click; the properties pane reads the same
 * selection to decide what it edits. Selection is *not* an edit, so it rides its own context rather
 * than the `editor` prop the structure edits already thread.
 *
 * `selectedId` is the id of the selected node, or `null` when the file's own properties are shown
 * (an empty-canvas click deselects every node). `onSelect` reports a node single-click by id, or a
 * background click as `null`.
 */
export interface Selection {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const SelectionContext = createContext<Selection | null>(null);

export function SelectionProvider({ value, children }: { value: Selection; children: ReactNode }): JSX.Element {
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The active selection, or `null` when the tree renders read-only (no selection wired, e.g. #367). */
export function useSelection(): Selection | null {
  return useContext(SelectionContext);
}
