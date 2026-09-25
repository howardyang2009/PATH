import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { findById } from "./edit-tree.js";
import { directionGlyph, gotoDirection, incomingGotos } from "./goto-view.js";
import { useSelection } from "./selection-context.js";

/**
 * The canvas's goto view (#619, designer-spec § goto): a goto draws no edge, so its block, its target's
 * block and the target's incoming badge all read the jump off one shared value. The provider holds the
 * rendered file and the goto the pointer rests on; the selected goto comes from the selection context.
 * The highlighted target is the target of the hovered goto, else of the selected one.
 */

interface GotoView {
  file: WorkflowFile;
  /** First-level node name → the names of the gotos targeting it. */
  incoming: Map<string, string[]>;
  /** The ids of the first-level nodes: only these can be a target, so only these highlight or badge. */
  firstLevel: Set<string>;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}

const GotoContext = createContext<GotoView | null>(null);

export function GotoProvider({ file, children }: { file: WorkflowFile; children: ReactNode }): JSX.Element {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const incoming = useMemo(() => incomingGotos(file), [file]);
  const firstLevel = useMemo(() => new Set(file.body.map((node) => node.id)), [file]);
  return <GotoContext.Provider value={{ file, incoming, firstLevel, hoveredId, setHoveredId }}>{children}</GotoContext.Provider>;
}

/** The target name of the goto `id` in `file`, or `null` when `id` names no goto. */
function targetOf(file: WorkflowFile, id: string | null): string | null {
  if (id === null) return null;
  const node = findById(file.body, id);
  return node?.type === "goto" ? node.target : null;
}

/** Is `node` the highlighted target of the hovered or selected goto? `false` outside a provider. */
export function useIsGotoTarget(node: WorkflowNode): boolean {
  const view = useContext(GotoContext);
  const selection = useSelection();
  if (!view || !view.firstLevel.has(node.id)) return false;
  const target = targetOf(view.file, view.hoveredId) ?? targetOf(view.file, selection?.selectedId ?? null);
  return target !== null && target === node.name;
}

/** The `← N` badge on a first-level node that gotos target; its title lists them. */
export function IncomingBadge({ node }: { node: WorkflowNode }): JSX.Element | null {
  const view = useContext(GotoContext);
  if (!view || !view.firstLevel.has(node.id)) return null;
  const sources = view.incoming.get(node.name);
  if (!sources) return null;
  return (
    <span className="goto-incoming" title={`Targeted by goto ${sources.join(", ")}`}>
      ← {sources.length}
    </span>
  );
}

/** The `→ <target>` chip with its direction glyph, and the hover handlers that highlight the target. */
export function useGotoChip(node: Extract<WorkflowNode, { type: "goto" }>): {
  chip: JSX.Element;
  hover: { onMouseEnter?: () => void; onMouseLeave?: () => void };
} {
  const view = useContext(GotoContext);
  const direction = view ? gotoDirection(view.file, node.id) : null;
  const chip = (
    <span className="goto-chip">
      <span className="goto-target">{node.target === "" ? "→ (no target)" : `→ ${node.target}`}</span>
      {direction ? (
        <span className="goto-direction" aria-label={direction}>
          {directionGlyph(direction)}
        </span>
      ) : null}
    </span>
  );
  if (!view) return { chip, hover: {} };
  return { chip, hover: { onMouseEnter: () => view.setHoveredId(node.id), onMouseLeave: () => view.setHoveredId(null) } };
}
