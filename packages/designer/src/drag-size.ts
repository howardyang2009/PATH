import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The one drag-set-dimension seam behind every resizable region of the Designer (the app shell's rails, the
 * run dock's height, and its column widths). It has two exports: `beginDrag`, the shared pointer-drag
 * **transport**, and `useDragSize`, a single persisted, clamped, keyboard-nudgeable scalar built on it. The
 * paired-pane hook (`usePaneWidths`, `use-pane-resize.ts`) drives its own coupled clamp but reuses the same
 * `beginDrag` transport, so the pointer-capture hardening below lives in exactly one place.
 */

/** What a caller feeds `beginDrag`: how a move maps to a size, the teardown, and the body cursor to show. */
export interface DragTransport {
  /** A `window` `pointermove` while the drag is live — read `clientX`/`clientY` and set the new size. */
  onMove: (e: PointerEvent) => void;
  /** Run once when the drag ends (pointer up) or the tree unmounts mid-drag — clear the caller's drag ref. */
  onEnd?: () => void;
  /** The body cursor held for the drag's duration. */
  cursor: "col-resize" | "row-resize";
}

/**
 * Start a pointer drag from a separator's `pointerdown` and return an idempotent `stop`. It **captures the
 * pointer on the handle** so later moves keep reaching us even when the cursor crosses a region whose own
 * handlers `stopPropagation` on `pointermove` (the canvas), or leaves the element entirely — the window
 * listeners are the transport, and capture is what keeps them fed. Both the `setPointerCapture` and its
 * release are guarded: a throw (a stale pointer id on some browsers) must not abort the drag setup or its
 * teardown. The caller keeps the returned `stop` in a ref and calls it on unmount, so a drag interrupted by
 * an unmount does not leak its `window` listeners.
 */
export function beginDrag(e: React.PointerEvent, t: DragTransport): () => void {
  const el = e.currentTarget as HTMLElement;
  // `preventDefault` on the caller's `pointerdown` can suppress the click's own focus, so focus the handle
  // explicitly — a plain click then leaves it focused and the arrow keys nudge it without a further Tab.
  el.focus();
  const pointerId = e.pointerId;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* capture unavailable — the window listeners below still drive the drag */
  }
  document.body.style.cursor = t.cursor;
  document.body.style.userSelect = "none";
  const onMove = (ev: PointerEvent): void => t.onMove(ev);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      /* already released (e.g. the pointer was lost) */
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    t.onEnd?.();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  return stop;
}

export interface DragSizeOptions {
  /** `localStorage` key the size persists under, as a plain number. */
  storageKey: string;
  /** The size used when nothing valid is stored. */
  defaultSize: number;
  /** Floor the size may not shrink below (also the `aria-valuemin`). */
  min: number;
  /** Ceiling the size may not grow past — a number, or a function read live (e.g. off `window.innerHeight`). */
  max: number | (() => number);
  /** The drag axis: `"x"` reads `clientX`, `"y"` reads `clientY`. */
  axis: "x" | "y";
  /** The pointer-delta sign that grows the size: `+1` handle-on-right/bottom, `-1` handle-on-left/top. */
  grow: 1 | -1;
  /** The body cursor for the drag. */
  cursor: "col-resize" | "row-resize";
  /** The separator's `aria-orientation` — a vertical bar resizes a width, a horizontal bar a height. */
  ariaOrientation: "vertical" | "horizontal";
}

/** The props to spread onto the separator element; the caller adds `className`, `aria-label`, `data-*`. */
export interface DragSizeHandleProps {
  role: "separator";
  "aria-orientation": "vertical" | "horizontal";
  "aria-valuenow": number;
  "aria-valuemin": number;
  tabIndex: 0;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface DragSize {
  /** The live size, in px; feed it to the region's inline `width`/`height`. */
  size: number;
  /** The drag/keyboard props for the region's separator. */
  handleProps: DragSizeHandleProps;
}

function resolveMax(max: number | (() => number)): number {
  return typeof max === "function" ? max() : max;
}

function clampSize(px: number, min: number, max: number | (() => number)): number {
  return Math.max(min, Math.min(resolveMax(max), px));
}

function loadSize(key: string, defaultSize: number, min: number): number {
  if (typeof localStorage === "undefined") return defaultSize;
  const raw = Number(localStorage.getItem(key));
  return raw >= min ? raw : defaultSize;
}

/**
 * A single drag-set dimension: a persisted, clamped size a separator resizes by pointer drag or arrow keys.
 * The run dock's height is one; the app shell and the run dock's columns use the paired `usePaneWidths`
 * instead, which composes the same `beginDrag` transport for its coupled two-pane clamp.
 */
export function useDragSize(opts: DragSizeOptions): DragSize {
  const { storageKey, defaultSize, min, max, axis, grow, cursor, ariaOrientation } = opts;
  const [size, setSize] = useState<number>(() => loadSize(storageKey, defaultSize, min));
  // Mirror `max` in a ref so the pointer-move callback can read a live `() => window.innerHeight` ceiling
  // without depending on the function's identity (a caller commonly passes an inline arrow).
  const maxRef = useRef(max);
  maxRef.current = max;
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, String(Math.round(size)));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [storageKey, size]);

  const onPointerMove = useCallback(
    (e: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = (axis === "x" ? e.clientX : e.clientY) - drag.start;
      setSize(clampSize(drag.startSize + delta * grow, min, maxRef.current));
    },
    [axis, grow, min],
  );

  // Drop any listeners left over if the tree unmounts mid-drag.
  useEffect(() => () => stopRef.current?.(), []);

  const handleProps = useCallback(
    (): DragSizeHandleProps => ({
      role: "separator",
      "aria-orientation": ariaOrientation,
      "aria-valuenow": Math.round(size),
      "aria-valuemin": min,
      tabIndex: 0,
      onPointerDown: (e) => {
        e.preventDefault();
        dragRef.current = { start: axis === "x" ? e.clientX : e.clientY, startSize: size };
        stopRef.current = beginDrag(e, { cursor, onMove: onPointerMove, onEnd: () => (dragRef.current = null) });
      },
      onKeyDown: (e) => {
        // Sign the step by `grow` so the separator tracks the arrow whichever edge it sits on. The
        // "positive screen delta" key is ArrowRight on x, ArrowDown on y (both raise client coord).
        const step = (e.shiftKey ? 32 : 8) * grow;
        const bigger = axis === "x" ? "ArrowRight" : "ArrowDown";
        const smaller = axis === "x" ? "ArrowLeft" : "ArrowUp";
        if (e.key === bigger) {
          e.preventDefault();
          setSize((s) => clampSize(s + step, min, maxRef.current));
        } else if (e.key === smaller) {
          e.preventDefault();
          setSize((s) => clampSize(s - step, min, maxRef.current));
        }
      },
    }),
    [ariaOrientation, size, min, axis, cursor, onPointerMove, grow],
  );

  return { size, handleProps: handleProps() };
}
