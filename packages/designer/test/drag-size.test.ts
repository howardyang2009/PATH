import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDragSize, type DragSizeOptions } from "../src/drag-size.js";

/**
 * The one drag-set-dimension seam (`drag-size.ts`). These drive `useDragSize` head-on — the size, the
 * persistence round-trip, and the keyboard nudge with its clamp — without mounting the DOM-heavy run dock
 * it now backs. The pointer-drag transport (`beginDrag`) is exercised through the app/run-surface renders;
 * here the clamp and the arrow-key arithmetic are the pure surface under test.
 */

const KEY = "path.test.drag-size";

/** The run dock's height case: a top-edge handle (drag/ArrowUp grows), min 160, max fixed at 400 for the test. */
function heightOpts(over: Partial<DragSizeOptions> = {}): DragSizeOptions {
  return {
    storageKey: KEY,
    defaultSize: 320,
    min: 160,
    max: 400,
    axis: "y",
    grow: -1,
    cursor: "row-resize",
    ariaOrientation: "horizontal",
    ...over,
  };
}

/** A minimal React.KeyboardEvent stand-in for `handleProps.onKeyDown`. */
function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: () => {} } as unknown as React.KeyboardEvent;
}

afterEach(() => {
  localStorage.clear();
});

describe("useDragSize", () => {
  it("starts at the default when nothing is stored", () => {
    const { result } = renderHook(() => useDragSize(heightOpts()));
    expect(result.current.size).toBe(320);
  });

  it("loads a persisted size at or above the floor", () => {
    localStorage.setItem(KEY, "240");
    const { result } = renderHook(() => useDragSize(heightOpts()));
    expect(result.current.size).toBe(240);
  });

  it("ignores a persisted size below the floor and takes the default", () => {
    localStorage.setItem(KEY, "80");
    const { result } = renderHook(() => useDragSize(heightOpts()));
    expect(result.current.size).toBe(320);
  });

  it("grows on the increase arrow and persists the new size", () => {
    const { result } = renderHook(() => useDragSize(heightOpts()));
    // The top-edge handle grows on ArrowUp (the height case), shrinks on ArrowDown.
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowUp")));
    expect(result.current.size).toBe(328);
    expect(localStorage.getItem(KEY)).toBe("328");
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowDown")));
    expect(result.current.size).toBe(320);
  });

  it("takes the larger step with Shift held", () => {
    const { result } = renderHook(() => useDragSize(heightOpts()));
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowUp", true)));
    expect(result.current.size).toBe(352);
  });

  it("clamps at the ceiling and the floor", () => {
    localStorage.setItem(KEY, "398");
    const { result } = renderHook(() => useDragSize(heightOpts()));
    // One nudge would overshoot 400 — it pins to the max, not past it.
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowUp")));
    expect(result.current.size).toBe(400);
    // Drive it down past the floor; it pins to the min.
    for (let i = 0; i < 40; i++) {
      act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowDown", true)));
    }
    expect(result.current.size).toBe(160);
  });

  it("reads a live function ceiling", () => {
    localStorage.setItem(KEY, "300");
    let ceiling = 320;
    const { result } = renderHook(() => useDragSize(heightOpts({ max: () => ceiling })));
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowUp", true)));
    // 300 + 32 = 332, capped at the live 320.
    expect(result.current.size).toBe(320);
    ceiling = 400;
    act(() => result.current.handleProps.onKeyDown(keyEvent("ArrowUp", true)));
    // The ceiling moved; the same nudge now lands at 352.
    expect(result.current.size).toBe(352);
  });

  it("exposes the separator's aria size range", () => {
    localStorage.setItem(KEY, "260");
    const { result } = renderHook(() => useDragSize(heightOpts()));
    expect(result.current.handleProps).toMatchObject({
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-valuenow": 260,
      "aria-valuemin": 160,
      tabIndex: 0,
    });
  });
});
