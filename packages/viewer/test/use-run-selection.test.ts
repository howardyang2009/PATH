import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRunSelection } from "../src/use-run-selection.js";

/**
 * The one run selection both consoles mount: which root run is watched, which node run is selected,
 * and the reload nudge a launch or a delete owes the runs list.
 */
describe("useRunSelection", () => {
  it("watching a root run drops the node selection from the previous tree", () => {
    const { result } = renderHook(() => useRunSelection());

    act(() => result.current.selectRootRun("root-1"));
    act(() => result.current.selectRun("node-run-1"));
    expect(result.current.selectedRunId).toBe("node-run-1");

    act(() => result.current.selectRootRun("root-2"));
    expect(result.current.rootRunId).toBe("root-2");
    expect(result.current.selectedRunId).toBeNull();
  });

  it("a launch watches the new root and nudges the list", () => {
    const { result } = renderHook(() => useRunSelection());
    const before = result.current.reloadNonce;

    act(() => result.current.watchNewRun("root-1"));

    expect(result.current.rootRunId).toBe("root-1");
    expect(result.current.reloadNonce).toBe(before + 1);
  });

  it("a delete clears the watch only when it removed the watched run", () => {
    const { result } = renderHook(() => useRunSelection());
    act(() => result.current.watchNewRun("root-1"));

    act(() => result.current.onDeleted("other-root"));
    expect(result.current.rootRunId).toBe("root-1");

    act(() => result.current.onDeleted("root-1"));
    expect(result.current.rootRunId).toBeNull();
  });

  it("a scope change re-bases the selection on the new document", () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) => useRunSelection(scope),
      { initialProps: { scope: "a.workflow.json" } },
    );
    act(() => result.current.watchNewRun("root-1"));

    rerender({ scope: "b.workflow.json" });
    expect(result.current.rootRunId).toBeNull();
    expect(result.current.selectedRunId).toBeNull();
  });
});
