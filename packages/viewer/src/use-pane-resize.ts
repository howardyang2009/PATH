import type { RefObject } from "react";
import { type DimensionHandleProps, useResizableDimension } from "./resizable-dimension.js";

/**
 * Drag-set pane widths with one fluid neighbour: two panes carry an explicit px width, the third
 * takes what is left. The two may sit adjacent or on opposite sides — the clamp is the same either
 * way — and `grow` signs which pointer direction widens each. The clamp is coupled (each pane's max
 * reads the other's live width), so it is this adapter's model; transport, persistence and keys are
 * the shared `useResizableDimension`.
 */
export interface PaneWidthsOptions {
  /** `localStorage` key the two widths persist under, as JSON `[a, b]`. */
  storageKey: string;
  defaults: readonly [number, number];
  /** Floor for each resizable pane; `fluidMin` is the fluid region's. */
  min: number;
  /** Absolute ceiling for each pane, when the caller wants one independent of the container. */
  max?: number;
  fluidMin: number;
  separatorSpan: number;
  containerRef: RefObject<HTMLElement | null>;
  /** Per-pane pointer-delta sign that widens it: `+1` handle-on-right, `-1` handle-on-left. */
  grow: readonly [1 | -1, 1 | -1];
}

/** The props to spread onto a separator element; the caller adds `className`, `aria-label`,
 * `data-*`. */
export type PaneHandleProps = DimensionHandleProps;

export interface PaneWidths {
  /** The two live widths, in px; feed each to its pane's inline `width`. */
  widths: [number, number];
  /** Build the drag/keyboard props for separator `index` (0 = first pane, 1 = second). */
  handleProps: (index: 0 | 1) => PaneHandleProps;
}

/** The stored pair, or `defaults` when it is absent, malformed or below the floor. */
function loadWidths(
  raw: string | null,
  defaults: readonly [number, number],
  min: number,
): [number, number] {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => typeof n === "number" && n >= min)
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    /* absent or malformed storage — the defaults below */
  }
  return [defaults[0], defaults[1]];
}

export function usePaneWidths(opts: PaneWidthsOptions): PaneWidths {
  const {
    storageKey,
    defaults,
    min,
    max: ceiling,
    fluidMin,
    separatorSpan,
    containerRef,
    grow,
  } = opts;

  const dimension = useResizableDimension({
    storageKey,
    read: (raw) => loadWidths(raw, defaults, min),
    write: (values) => JSON.stringify(values.map(Math.round)),
    // The neighbour's live width bounds this pane: the fluid region must keep its own floor.
    clamp: (values, index, next) => {
      const container = containerRef.current?.clientWidth ?? 0;
      const other = values[index === 0 ? 1 : 0] ?? min;
      const fluid = container > 0 ? container - other - fluidMin - separatorSpan : Infinity;
      const max = Math.min(ceiling ?? Infinity, Math.max(min, fluid));
      const width = Math.max(min, Math.min(max, next));
      const nextValues: [number, number] = [values[0] ?? defaults[0], values[1] ?? defaults[1]];
      nextValues[index] = width;
      return nextValues;
    },
    grow,
    min,
    axis: "x",
    cursor: "col-resize",
    ariaOrientation: "vertical",
  });

  const widths: [number, number] = [
    dimension.values[0] ?? defaults[0],
    dimension.values[1] ?? defaults[1],
  ];
  return { widths, handleProps: (index) => dimension.handleProps(index) };
}
