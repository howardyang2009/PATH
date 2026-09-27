import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The one drag-set-dimension seam: `beginDrag`, the pointer transport, and
 * `useResizableDimension`, which owns persistence, the pointer delta, the clamp and the keyboard
 * nudge over a caller's pixel-value model. A size and a pane pair are the two models it serves.
 */

/** What a caller feeds `beginDrag`: how a move maps to a size, the teardown, and the body cursor to
 * show. */
export interface DragTransport {
  /** A `window` `pointermove` while the drag is live — read `clientX`/`clientY` and set the new
   * size. */
  onMove: (e: PointerEvent) => void;
  /** Run once when the drag ends (pointer up) or the tree unmounts mid-drag — clear the caller's
   * drag ref. */
  onEnd?: () => void;
  cursor: "col-resize" | "row-resize";
}

/** Start a pointer drag from a separator's `pointerdown` and return an idempotent `stop`. It
 * **captures the pointer on the handle** so later moves keep reaching us even when the cursor
 * crosses a region whose handlers `stopPropagation` on `pointermove` (the canvas), or leaves the
 * element. Both `setPointerCapture` and its release are guarded, so a throw (a stale pointer id)
 * cannot abort setup or teardown. */
export function beginDrag(e: React.PointerEvent, t: DragTransport): () => void {
  const el = e.currentTarget as HTMLElement;
  // `preventDefault` on the caller's `pointerdown` can suppress the click's own focus, so focus the
  // handle explicitly — a plain click then leaves it focused and the arrow keys nudge it without a
  // further Tab.
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

/** The props to spread onto a separator element; the caller adds `className`, `aria-label`,
 * `data-*`. */
export interface DimensionHandleProps {
  role: "separator";
  "aria-orientation": "vertical" | "horizontal";
  "aria-valuenow": number;
  "aria-valuemin": number;
  tabIndex: 0;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/** Arrow-key nudge, in px, and the `Shift` multiple. */
const KEY_STEP_PX = 8;
const KEY_STEP_LARGE_PX = 32;

/**
 * One resizable dimension's rules: its one or two pixel values, how they persist, and how a pointer
 * delta or a keyboard nudge moves the value a handle owns. The transport, the teardown, the write
 * effect and the key mapping below are the same for every model.
 */
export interface ResizableModel {
  /** `localStorage` key the values persist under. */
  storageKey: string;
  /** The stored values, or the caller's defaults when the string is absent or malformed. */
  read(raw: string | null): number[];
  write(values: readonly number[]): string;
  /**
   * The next whole state after `next` is asked of the value at `index` — where a floor, a ceiling or
   * a neighbour's live width is applied. `values` is the state the gesture started from.
   */
  clamp(values: readonly number[], index: 0 | 1, next: number): number[];
  /** The signed multiplier a positive pointer/keyboard delta takes per index. */
  grow: readonly number[];
  /** Floor each value may not shrink below; also the handles' `aria-valuemin`. */
  min: number;
  axis: "x" | "y";
  cursor: "col-resize" | "row-resize";
  /** A vertical bar resizes a width, a horizontal bar a height. */
  ariaOrientation: "vertical" | "horizontal";
}

export interface ResizableDimension {
  /** The live values, in px; feed each to its region's inline `width`/`height`. */
  values: readonly number[];
  /** The props for the separator that drags value `index` (0 when there is one). */
  handleProps(index?: 0 | 1): DimensionHandleProps;
}

function readStored(storageKey: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function useResizableDimension(model: ResizableModel): ResizableDimension {
  // The model is rebuilt per render (its closures read live refs), so the hook reads the latest one
  // without re-initialising its state.
  const modelRef = useRef(model);
  modelRef.current = model;
  const [values, setValues] = useState<number[]>(() =>
    modelRef.current.read(readStored(model.storageKey)),
  );
  const dragRef = useRef<{ index: 0 | 1; startPx: number; from: readonly number[] } | null>(null);
  // The active drag's teardown, so an unmount mid-drag can drop its listeners.
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(modelRef.current.storageKey, modelRef.current.write(values));
    } catch {
      /* storage blocked — the resize still holds for this session */
    }
  }, [values]);

  const onPointerMove = useCallback((e: PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const current = modelRef.current;
    const position = current.axis === "x" ? e.clientX : e.clientY;
    const asked =
      (drag.from[drag.index] ?? 0) + (position - drag.startPx) * (current.grow[drag.index] ?? 1);
    setValues(current.clamp(drag.from, drag.index, asked));
  }, []);

  // Drop any listeners left over if the tree unmounts mid-drag.
  useEffect(() => () => stopRef.current?.(), []);

  const handleProps = (index: 0 | 1 = 0): DimensionHandleProps => {
    const current = modelRef.current;
    return {
      role: "separator",
      "aria-orientation": current.ariaOrientation,
      "aria-valuenow": Math.round(values[index] ?? current.min),
      "aria-valuemin": current.min,
      tabIndex: 0,
      onPointerDown: (e) => {
        e.preventDefault();
        dragRef.current = {
          index,
          startPx: current.axis === "x" ? e.clientX : e.clientY,
          from: values,
        };
        stopRef.current = beginDrag(e, {
          cursor: current.cursor,
          onMove: onPointerMove,
          onEnd: () => {
            dragRef.current = null;
          },
        });
      },
      onKeyDown: (e) => {
        // Sign the step by `grow` so the separator tracks the arrow whichever edge it sits on. The
        // "positive screen delta" key is ArrowRight on x, ArrowDown on y (both raise the client
        // coordinate).
        const step = (e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX) * (current.grow[index] ?? 1);
        const bigger = current.axis === "x" ? "ArrowRight" : "ArrowDown";
        const smaller = current.axis === "x" ? "ArrowLeft" : "ArrowUp";
        if (e.key === bigger) {
          e.preventDefault();
          setValues(current.clamp(values, index, (values[index] ?? current.min) + step));
        } else if (e.key === smaller) {
          e.preventDefault();
          setValues(current.clamp(values, index, (values[index] ?? current.min) - step));
        }
      },
    };
  };

  return { values, handleProps };
}
