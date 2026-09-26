import { createContext, type ReactNode, useContext } from "react";

/** The node validation markers, threaded to every block without drilling through each block signature:
 * `node-id → marker message`, computed by `problems.ts` — every cross-node error the canvas cannot catch
 * node-by-node. A node with several problems carries one newline-joined marker. It rides its own context
 * because a marker is a read-only derivation of the file, so a read-only render still shows it. */
const ConflictContext = createContext<ReadonlyMap<string, string>>(new Map());

export function ConflictProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, string>;
  children: ReactNode;
}): JSX.Element {
  return <ConflictContext.Provider value={value}>{children}</ConflictContext.Provider>;
}

/** The validation marker message for a node id, or `undefined` when the node has no problem. */
export function useConflict(id: string): string | undefined {
  return useContext(ConflictContext).get(id);
}

/** The small ⚠ marker a block shows when its node carries a cross-node error, its message on hover. */
export function ConflictMarker({ id }: { id: string }): JSX.Element | null {
  const message = useConflict(id);
  if (!message) return null;
  return (
    <span
      className="node-marker"
      role="img"
      aria-label={`Validation error: ${message}`}
      title={message}
    >
      ⚠
    </span>
  );
}
