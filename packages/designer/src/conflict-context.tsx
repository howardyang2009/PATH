import { createContext, useContext, type ReactNode } from "react";

/**
 * The node validation markers, threaded to every block without drilling through each block signature
 * (#370, designer-spec § Context reads and writes). Context is invisible plumbing — a read is an
 * interpolation, a write is a `publish` pane field — but a **publish conflict the load-time checks
 * reject** is a load error the author must see, so the canvas marks the offending node. The map is
 * `node-id → marker message`, computed by `publish-conflicts.ts` from the file being rendered.
 *
 * It rides its own context, not the `editor` prop, because a marker is a read-only derivation of the
 * file rather than an edit affordance — and a read-only render (#367, no editor) still shows it.
 */
const ConflictContext = createContext<ReadonlyMap<string, string>>(new Map());

export function ConflictProvider({ value, children }: { value: ReadonlyMap<string, string>; children: ReactNode }): JSX.Element {
  return <ConflictContext.Provider value={value}>{children}</ConflictContext.Provider>;
}

/** The validation marker message for a node id, or `undefined` when the node has no conflict. */
export function useConflict(id: string): string | undefined {
  return useContext(ConflictContext).get(id);
}

/** The small ⚠ marker a block shows when its node carries a publish conflict, its message on hover. */
export function ConflictMarker({ id }: { id: string }): JSX.Element | null {
  const message = useConflict(id);
  if (!message) return null;
  return (
    <span className="node-marker" role="img" aria-label={`Validation error: ${message}`} title={message}>
      ⚠
    </span>
  );
}
