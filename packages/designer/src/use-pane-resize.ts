import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { beginDrag } from "./drag-size.js";

/**
 * A pair of drag-set pane widths with one fluid neighbour — the width mechanics behind the run dock's
 * three panes (RUNS │ RUN DETAIL │ NODE I/O) and the app shell's palette │ canvas │ properties rails.
 * Two panes carry an explicit px width; the third region (the canvas stage, or the run dock's node pane)
 * takes whatever is left. Widths persist in `localStorage`.
 *
 * The two explicit panes may sit adjacent (run dock: left + middle, fluid on the far right) or on
 * opposite sides (shell: left + right, fluid in the middle) — the clamp is the same either way, since
 * it only asks that the two widths plus the fluid floor plus the separators fit the container. `grow`
 * says which pointer direction widens each pane: `+1` when its drag handle is on the pane's right edge,
 * `-1` when on its left edge, so an arrow key or a drag always moves the separator the way it points.
 *
 * The clamp here is coupled (each pane's max reads the other's live width), so it is this hook's own; the
 * pointer transport — capture, body cursor, `window` listeners, teardown — is the shared `beginDrag`
 * (`drag-size.ts`), the same one the single-dimension `useDragSize` uses, so the pointer-capture hardening
 * is defined once for every resizable region.
 */
export interface PaneWidthsOptions {
  /** `localStorage` key the two widths persist under, as JSON `[a, b]`. */
  storageKey: string;
  /** Widths used when nothing valid is stored. */
  defaults: readonly [number, number];
  /** Floor each resizable pane may not shrink below. */
  min: number;
  /** Floor the fluid region (canvas / node pane) may not shrink below. */
  fluidMin: number;
  /** Combined width of the drag separators, reserved when clamping. */
  separatorSpan: number;
  /** The container the panes live in; its `clientWidth` bounds the drag. */
  containerRef: RefObject<HTMLElement | null>;
  /** Per-pane pointer-delta sign that widens it: `+1` handle-on-right, `-1` handle-on-left. */
  grow: readonly [1 | -1, 1 | -1];
}

/** The props to spread onto a separator element; the caller adds `className`, `aria-label`, `data-*`. */
export interface PaneHandleProps {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-valuenow": number;
  "aria-valuemin": number;
  tabIndex: 0;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface PaneWidths {
  /** The two live widths, in px; feed each to its pane's inline `width`. */
  widths: [number, number];
  /** Build the drag/keyboard props for separator `index` (0 = first pane, 1 = second). */
  handleProps: (index: 0 | 1) => PaneHandleProps;
}

function loadWidths(key: string, defaults: readonly [number, number], min: number): [number, number] {
  if (typeof localStorage === "undefined") return [defaults[0], defaults[1]];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "");
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => typeof n === "number" && n >= min)
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    /* absent or malformed — fall back to the defaults */
  }
  return [defaults[0], defaults[1]];
}

export function usePaneWidths(opts: PaneWidthsOptions): PaneWidths {
  const { storageKey, defaults, min, fluidMin, separatorSpan, containerRef, grow } = opts;
  const [widths, setWidths] = useState<[number, number]>(() => loadWidths(storageKey, defaults, min));
  // Mirror `grow` in a ref so the drag callbacks below can read it without depending on its identity.
  // A caller commonly passes an inline `[1, -1]` literal, so `grow` is a new array every render; if the
  // pointer-move/end-drag callbacks depended on it they would be rebuilt on the first `setWidth`
  // re-render, and the unmount-cleanup effect (keyed on `endDrag`) would then fire mid-drag and tear out
  // the `window` listeners — the drag would die after one move (a real, spaced-out drag re-renders
  // between moves; a burst of synthetic events does not, which is why this only bites live dragging).
  const growRef = useRef(grow);
  growRef.current = grow;
  const dragRef = useRef<{ index: 0 | 1; startX: number; startWidth: number } | null>(null);
  // The active drag's teardown (from `beginDrag`), so an unmount mid-drag can drop its listeners.
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths.map(Math.round)));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [storageKey, widths]);

  // Resize pane `index` to `px`, keeping it, the other pane, and the fluid region above their floors.
  const setWidth = useCallback(
    (index: 0 | 1, px: number) => {
      setWidths((prev) => {
        const container = containerRef.current?.clientWidth ?? 0;
        const other = prev[index === 0 ? 1 : 0];
        const max =
          container > 0 ? Math.max(min, container - other - fluidMin - separatorSpan) : Infinity;
        const width = Math.max(min, Math.min(max, px));
        const next: [number, number] = [prev[0], prev[1]];
        next[index] = width;
        return next;
      });
    },
    [containerRef, min, fluidMin, separatorSpan],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setWidth(drag.index, drag.startWidth + (e.clientX - drag.startX) * growRef.current[drag.index]);
    },
    [setWidth],
  );

  // Drop any listeners left over if the tree unmounts mid-drag.
  useEffect(() => () => stopRef.current?.(), []);

  const handleProps = useCallback(
    (index: 0 | 1): PaneHandleProps => ({
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(widths[index]),
      "aria-valuemin": min,
      tabIndex: 0,
      onPointerDown: (e) => {
        e.preventDefault();
        dragRef.current = { index, startX: e.clientX, startWidth: widths[index] };
        // The shared transport captures the pointer on the handle (past the canvas's `stopPropagation`),
        // holds the col-resize cursor, and clears the drag ref on pointer up.
        stopRef.current = beginDrag(e, { cursor: "col-resize", onMove: onPointerMove, onEnd: () => (dragRef.current = null) });
      },
      onKeyDown: (e) => {
        // Sign the step by `grow` so the separator tracks the arrow whichever edge it sits on.
        const step = (e.shiftKey ? 32 : 8) * growRef.current[index];
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setWidth(index, widths[index] - step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setWidth(index, widths[index] + step);
        }
      },
    }),
    [widths, min, onPointerMove, setWidth],
  );

  return { widths, handleProps };
}
