import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { beginDrag } from "./drag-size.js";

/**
 * Drag-set pane widths with one fluid neighbour: two panes carry an explicit px width, the third takes
 * what is left. The two may sit adjacent or on opposite sides — the clamp is the same either way — and
 * `grow` signs which pointer direction widens each. The clamp is coupled (each pane's max reads the
 * other's live width), so it is this hook's own; pointer transport is the shared `beginDrag`.
 */
export interface PaneWidthsOptions {
  /** `localStorage` key the two widths persist under, as JSON `[a, b]`. */
  storageKey: string;
  defaults: readonly [number, number];
  /** Floor for each resizable pane; `fluidMin` is the fluid region's. */
  min: number;
  fluidMin: number;
  separatorSpan: number;
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

function loadWidths(
  key: string,
  defaults: readonly [number, number],
  min: number,
): [number, number] {
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
  } catch {}
  return [defaults[0], defaults[1]];
}

export function usePaneWidths(opts: PaneWidthsOptions): PaneWidths {
  const { storageKey, defaults, min, fluidMin, separatorSpan, containerRef, grow } = opts;
  const [widths, setWidths] = useState<[number, number]>(() =>
    loadWidths(storageKey, defaults, min),
  );
  // Mirror `grow` in a ref: callers commonly pass an inline `[1, -1]` literal, so depending on it would
  // rebuild the drag callbacks on the first `setWidth` re-render and let the unmount-cleanup effect tear
  // out the `window` listeners mid-drag.
  const growRef = useRef(grow);
  growRef.current = grow;
  const dragRef = useRef<{ index: 0 | 1; startX: number; startWidth: number } | null>(null);
  // The active drag's teardown, so an unmount mid-drag can drop its listeners.
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths.map(Math.round)));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [storageKey, widths]);

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
      setWidth(
        drag.index,
        drag.startWidth + (e.clientX - drag.startX) * growRef.current[drag.index],
      );
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
        // The shared transport captures the pointer, holds the cursor, and clears the drag ref on pointer up.
        stopRef.current = beginDrag(e, {
          cursor: "col-resize",
          onMove: onPointerMove,
          onEnd: () => (dragRef.current = null),
        });
      },
      onKeyDown: (e) => {
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
