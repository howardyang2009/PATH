import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type PaneWidthsOptions, usePaneWidths } from "../src/use-pane-resize.js";

/**
 * The paired model over the shared drag dimension (`use-pane-resize.ts`): two persisted widths whose
 * clamp reads the container and the neighbour. These drive the hook head-on — the persistence
 * round-trip, the coupled fluid clamp and the signed keyboard nudge — without mounting the app
 * shell it backs.
 */

const KEY = "path.test.pane-widths";

/** A 1000px container with a left rail of 260 and a middle pane of 320: the third pane is fluid. */
function paneOpts(over: Partial<PaneWidthsOptions> = {}): PaneWidthsOptions {
  return {
    storageKey: KEY,
    defaults: [260, 320],
    min: 180,
    fluidMin: 200,
    separatorSpan: 12,
    containerRef: { current: { clientWidth: 1000 } as HTMLElement },
    grow: [1, -1],
    ...over,
  };
}

/** A minimal React.KeyboardEvent stand-in for `handleProps(index).onKeyDown`. */
function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: () => {} } as unknown as React.KeyboardEvent;
}

afterEach(() => {
  localStorage.clear();
});

describe("usePaneWidths", () => {
  it("starts at the defaults when nothing is stored", () => {
    const { result } = renderHook(() => usePaneWidths(paneOpts()));
    expect(result.current.widths).toEqual([260, 320]);
  });

  it("round-trips a persisted pair, and ignores a malformed one", () => {
    localStorage.setItem(KEY, JSON.stringify([300, 300]));
    const stored = renderHook(() => usePaneWidths(paneOpts()));
    expect(stored.result.current.widths).toEqual([300, 300]);

    localStorage.setItem(KEY, JSON.stringify([100]));
    const malformed = renderHook(() => usePaneWidths(paneOpts()));
    expect(malformed.result.current.widths).toEqual([260, 320]);
  });

  it("nudges each pane in its own grow direction, and persists", () => {
    const { result } = renderHook(() => usePaneWidths(paneOpts()));

    // Pane 0 grows on ArrowRight (+1); pane 1 grows on ArrowLeft (-1).
    act(() => result.current.handleProps(0).onKeyDown(keyEvent("ArrowRight")));
    expect(result.current.widths).toEqual([268, 320]);
    act(() => result.current.handleProps(1).onKeyDown(keyEvent("ArrowLeft")));
    expect(result.current.widths).toEqual([268, 328]);

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify([268, 328]));
  });

  it("clamps a pane to the floor and to the container's fluid max", () => {
    const { result } = renderHook(() => usePaneWidths(paneOpts()));

    // The fluid region keeps its 200px floor: 1000 - 320 - 200 - 12 = 468 is pane 0's ceiling.
    for (let i = 0; i < 40; i++) {
      act(() => result.current.handleProps(0).onKeyDown(keyEvent("ArrowRight", true)));
    }
    expect(result.current.widths[0]).toBe(468);

    for (let i = 0; i < 60; i++) {
      act(() => result.current.handleProps(0).onKeyDown(keyEvent("ArrowLeft", true)));
    }
    expect(result.current.widths[0]).toBe(180);
  });

  it("announces each handle's own width and the shared floor", () => {
    localStorage.setItem(KEY, JSON.stringify([300, 340]));
    const { result } = renderHook(() => usePaneWidths(paneOpts()));

    expect(result.current.handleProps(0)).toMatchObject({
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": 300,
      "aria-valuemin": 180,
      tabIndex: 0,
    });
    expect(result.current.handleProps(1)).toMatchObject({ "aria-valuenow": 340 });
  });
});
