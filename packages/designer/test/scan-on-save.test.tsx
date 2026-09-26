import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useScanOnSave } from "../src/scan-on-save.js";
import type { SaveState } from "../src/session-reducer.js";

const RESCAN_ON: readonly SaveState["phase"][] = ["saved"];

function strict({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useScanOnSave", () => {
  // The liveness flag is set on mount, so StrictMode's dev mount-unmount-mount leaves it live.
  it("lands its scan under StrictMode", async () => {
    const fetch = vi.fn(() => Promise.resolve(["a"]));
    const { result } = renderHook(() => useScanOnSave(fetch, "idle", RESCAN_ON), {
      wrapper: strict,
    });
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", value: ["a"] }));
  });

  it("re-scans when a named save phase lands, and not on others", async () => {
    let n = 0;
    const fetch = vi.fn(() => Promise.resolve([`scan-${++n}`]));
    const { result, rerender } = renderHook(
      ({ phase }: { phase: SaveState["phase"] }) => useScanOnSave(fetch, phase, RESCAN_ON),
      {
        initialProps: { phase: "idle" as SaveState["phase"] },
      },
    );
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", value: ["scan-1"] }));
    rerender({ phase: "saving" });
    rerender({ phase: "saved" });
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", value: ["scan-2"] }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value beside a failure", async () => {
    let fail = false;
    const fetch = vi.fn(() =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve(["kept"]),
    );
    const { result, rerender } = renderHook(
      ({ phase }: { phase: SaveState["phase"] }) => useScanOnSave(fetch, phase, RESCAN_ON),
      {
        initialProps: { phase: "idle" as SaveState["phase"] },
      },
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    fail = true;
    rerender({ phase: "saved" });
    await waitFor(() =>
      expect(result.current).toEqual({ phase: "error", message: "offline", lastGood: ["kept"] }),
    );
  });
});
