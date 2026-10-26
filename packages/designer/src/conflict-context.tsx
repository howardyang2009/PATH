import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { createContext, type ReactNode, useContext } from "react";
import { useTranslations } from "use-intl";

/** The node validation markers, threaded to every block without drilling through each block
 * signature: `node-id → marker message`, computed by `problems.ts` — every cross-node error the
 * canvas cannot catch node-by-node. A node with several problems carries one marker, its messages
 * one per line.
 * It rides its own context because a marker is a read-only derivation of the file, so a read-only
 * render still shows it. */
const ConflictContext = createContext<ReadonlyMap<string, readonly Message[]>>(new Map());

export function ConflictProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, readonly Message[]>;
  children: ReactNode;
}): JSX.Element {
  return <ConflictContext.Provider value={value}>{children}</ConflictContext.Provider>;
}

/** The validation marker text for a node id, or `undefined` when the node has no problem. */
export function useConflict(id: string): string | undefined {
  const renderMessage = useMessage();
  return useContext(ConflictContext).get(id)?.map(renderMessage).join("\n");
}

/** The small ⚠ marker a block shows when its node carries a cross-node error, its message on
 * hover. */
export function ConflictMarker({ id }: { id: string }): JSX.Element | null {
  const t = useTranslations();
  const message = useConflict(id);
  if (!message) return null;
  return (
    <span
      className="node-marker"
      role="img"
      aria-label={t("designer.problems.markerLabel", { message })}
      title={message}
    >
      ⚠
    </span>
  );
}
