import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResource } from "../src/use-resource.js";

/**
 * The one load lifecycle: the three-phase `Load`, the stale-landing drop, the direct value a
 * "nothing to fetch" read returns, and the poll/refetch re-reads. These drive the seam head-on, so
 * no pane has to.
 */

/** A read whose resolution the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useResource", () => {
  it("exposes loading, then the read's value", async () => {
    const gate = deferred<string>();
    const { result } = renderHook(() => useResource(() => gate.promise, []));

    expect(result.current.load.phase).toBe("loading");
    act(() => gate.resolve("first"));

    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "first" }));
  });

  it("lands a directly returned value without a round-trip", async () => {
    const { result } = renderHook(() => useResource(() => "known", []));

    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "known" }));
  });

  it("drops a slow landing the deps have already outrun", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const { result, rerender } = renderHook(
      ({ which }: { which: "slow" | "fast" }) =>
        useResource(() => (which === "slow" ? slow.promise : fast.promise), [which]),
      { initialProps: { which: "slow" as "slow" | "fast" } },
    );

    rerender({ which: "fast" });
    act(() => fast.resolve("fast"));
    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "fast" }));

    // The first read lands late; it belongs to a run the deps have left.
    act(() => slow.resolve("slow"));
    await Promise.resolve();
    expect(result.current.load).toEqual({ phase: "ready", value: "fast" });
  });

  it("re-reads on refetch without showing loading again", async () => {
    let value = "first";
    const { result } = renderHook(() => useResource(() => value, []));
    await waitFor(() => expect(result.current.load.phase).toBe("ready"));

    value = "second";
    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "second" }));
  });

  it("re-reads on its interval, keeping the last value until the new one lands", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const { result } = renderHook(() =>
        useResource(
          () => {
            reads += 1;
            return reads;
          },
          [],
          { pollMs: 100 },
        ),
      );
      expect(result.current.load).toEqual({ phase: "ready", value: 1 });

      act(() => vi.advanceTimersByTime(100));
      expect(reads).toBe(2);
      expect(result.current.load).toEqual({ phase: "ready", value: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs no read while disabled", () => {
    const read = vi.fn(() => "never");
    const { result } = renderHook(() => useResource(read, [], { enabled: false }));

    expect(read).not.toHaveBeenCalled();
    expect(result.current.load.phase).toBe("loading");
  });

  it("reports a thrown read as an error", async () => {
    const { result } = renderHook(() =>
      useResource(() => {
        throw new Error("nope");
      }, []),
    );

    await waitFor(() => expect(result.current.load).toEqual({ phase: "error", message: "nope" }));
  });

  it("reports a rejected read as an error", async () => {
    const { result } = renderHook(() => useResource(() => Promise.reject(new Error("down")), []));

    await waitFor(() => expect(result.current.load).toEqual({ phase: "error", message: "down" }));
  });

  it("carries the last landed value on an error when keepLastGood is set", async () => {
    let fail = false;
    const { result } = renderHook(() =>
      useResource(() => (fail ? Promise.reject(new Error("blip")) : Promise.resolve("kept")), [], {
        keepLastGood: true,
      }),
    );
    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "kept" }));

    fail = true;
    act(() => result.current.refetch());
    await waitFor(() =>
      expect(result.current.load).toEqual({ phase: "error", message: "blip", lastGood: "kept" }),
    );
  });

  it("a manual read keeps its value while a refetch is in flight", async () => {
    const gate = deferred<string>();
    let reads = 0;
    const { result } = renderHook(() =>
      useResource(
        () => {
          reads += 1;
          return reads === 1 ? "first" : gate.promise;
        },
        [],
        { manual: true },
      ),
    );
    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "first" }));

    act(() => result.current.refetch());
    // The new read is still in flight, so the last value stays on screen instead of a `loading`.
    expect(result.current.load).toEqual({ phase: "ready", value: "first" });

    act(() => gate.resolve("second"));
    await waitFor(() => expect(result.current.load).toEqual({ phase: "ready", value: "second" }));
  });
});
