import { type DimensionHandleProps, useResizableDimension } from "./resizable-dimension.js";

/** A single drag-set dimension: a persisted, clamped size a separator resizes by pointer drag or
 * arrow keys. The run dock's height is one; the paired columns use `usePaneWidths` over the same
 * transport. */

export { beginDrag, type DragTransport } from "./resizable-dimension.js";

/** The props to spread onto the separator element; the caller adds `className`, `aria-label`,
 * `data-*`. */
export type DragSizeHandleProps = DimensionHandleProps;

export interface DragSizeOptions {
  storageKey: string;
  defaultSize: number;
  /** Floor the size may not shrink below (also the `aria-valuemin`). */
  min: number;
  /** Ceiling the size may not grow past — a number, or a function read live (e.g. off
   * `window.innerHeight`). */
  max: number | (() => number);
  axis: "x" | "y";
  /** The pointer-delta sign that grows the size: `+1` handle-on-right/bottom, `-1`
   * handle-on-left/top. */
  grow: 1 | -1;
  cursor: "col-resize" | "row-resize";
  /** The separator's `aria-orientation` — a vertical bar resizes a width, a horizontal bar a
   * height. */
  ariaOrientation: "vertical" | "horizontal";
}

export interface DragSize {
  /** The live size, in px; feed it to the region's inline `width`/`height`. */
  size: number;
  handleProps: DragSizeHandleProps;
}

function resolveMax(max: number | (() => number)): number {
  return typeof max === "function" ? max() : max;
}

function clampSize(px: number, min: number, max: number | (() => number)): number {
  return Math.max(min, Math.min(resolveMax(max), px));
}

/** The stored size, or `defaultSize` when it is absent, malformed or below the floor. */
function loadSize(raw: string | null, defaultSize: number, min: number): number {
  const parsed = Number(raw);
  return raw !== null && parsed >= min ? parsed : defaultSize;
}

export function useDragSize(opts: DragSizeOptions): DragSize {
  const { storageKey, defaultSize, min, max, axis, grow, cursor, ariaOrientation } = opts;
  const dimension = useResizableDimension({
    storageKey,
    read: (raw) => [loadSize(raw, defaultSize, min)],
    write: (values) => String(Math.round(values[0] ?? defaultSize)),
    // One value, so the index is the only one there is; `max` is read live on every clamp.
    clamp: (_values, _index, next) => [clampSize(next, min, max)],
    grow: [grow],
    min,
    axis,
    cursor,
    ariaOrientation,
  });

  return {
    size: dimension.values[0] ?? defaultSize,
    handleProps: dimension.handleProps(0),
  };
}
