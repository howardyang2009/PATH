import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/**
 * A pair of drag-set pane widths with one fluid neighbour — the width mechanics behind the run dock's
 * three panes (RUNS │ RUN DETAIL │ NODE I/O), lifted here so the app shell's palette │ canvas │
 * properties rails resize identically. Two panes carry an explicit px width; the third region (the
 * canvas stage, or the run dock's node pane) takes whatever is left. Widths persist in `localStorage`.
 *
 * The two explicit panes may sit adjacent (run dock: left + middle, fluid on the far right) or on
 * opposite sides (shell: left + right, fluid in the middle) — the clamp is the same either way, since
 * it only asks that the two widths plus the fluid floor plus the separators fit the container. `grow`
 * says which pointer direction widens each pane: `+1` when its drag handle is on the pane's right edge,
 * `-1` when on its left edge, so an arrow key or a drag always moves the separator the way it points.
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
  // `el` + `pointerId` let the drag capture the pointer on the handle, so moves keep reaching us even
  // when the cursor crosses the canvas — whose node/pan handlers `stopPropagation` on `pointermove` and
  // would otherwise swallow the event before it bubbled to `window` and freeze the drag.
  const dragRef = useRef<{
    index: 0 | 1;
    startX: number;
    startWidth: number;
    el: Element;
    pointerId: number;
  } | null>(null);

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
      setWidth(drag.index, drag.startWidth + (e.clientX - drag.startX) * grow[drag.index]);
    },
    [grow, setWidth],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag) {
      try {
        drag.el.releasePointerCapture(drag.pointerId);
      } catch {
        /* already released (e.g. the pointer was lost) */
      }
    }
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  // Drop any listeners left over if the tree unmounts mid-drag.
  useEffect(() => endDrag, [endDrag]);

  const handleProps = useCallback(
    (index: 0 | 1): PaneHandleProps => ({
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(widths[index]),
      "aria-valuemin": min,
      tabIndex: 0,
      onPointerDown: (e) => {
        e.preventDefault();
        const el = e.currentTarget;
        // Route every later pointer event to the handle, past the canvas's own handlers.
        el.setPointerCapture(e.pointerId);
        dragRef.current = { index, startX: e.clientX, startWidth: widths[index], el, pointerId: e.pointerId };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", endDrag);
      },
      onKeyDown: (e) => {
        // Sign the step by `grow` so the separator tracks the arrow whichever edge it sits on.
        const step = (e.shiftKey ? 32 : 8) * grow[index];
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setWidth(index, widths[index] - step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setWidth(index, widths[index] + step);
        }
      },
    }),
    [widths, min, grow, onPointerMove, endDrag, setWidth],
  );

  return { widths, handleProps };
}
