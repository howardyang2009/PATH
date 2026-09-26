import { createContext, type ReactNode, useContext } from "react";

/** The canvas selection, threaded to every block without drilling it through component signatures. Selection
 * is not an edit, so it rides its own context; `selectedId` is `null` when the file's own properties show. */
export interface Selection {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const SelectionContext = createContext<Selection | null>(null);

export function SelectionProvider({
  value,
  children,
}: {
  value: Selection;
  children: ReactNode;
}): JSX.Element {
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The active selection, or `null` when the tree renders read-only (no selection wired). */
export function useSelection(): Selection | null {
  return useContext(SelectionContext);
}
