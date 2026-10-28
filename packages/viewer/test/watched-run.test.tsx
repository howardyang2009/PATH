import type { RunViewState } from "@path/client-core";
import { stubClient } from "@path/client-core/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWatchedRunReading, type WatchedRun } from "../src/watched-run.js";

const ROOT = "flows/main.workflow.json";

/** A watched run whose snapshot has landed: one root row, one selected leaf, one display overlay. */
function watched(over: Partial<RunViewState> = {}): WatchedRun {
  const value = {
    status: "running",
    displayStatus: new Map(),
    runs: new Map([
      ["root-1", { runId: "root-1", workflowPath: ROOT }],
      ["leaf-1", { runId: "leaf-1", nodeId: "n-leaf" }],
    ]),
    ...over,
  } as unknown as RunViewState;
  return {
    selection: {
      rootRunId: "root-1",
      selectedRunId: "leaf-1",
      reloadNonce: 0,
      selectRootRun: () => {},
      selectRun: () => {},
      watchNewRun: () => {},
      onDeleted: () => {},
    },
    load: { phase: "ready", value },
  };
}

const FILES = {
  [ROOT]: JSON.stringify({ format: "0", id: "wf", name: "main", body: [] }),
};

describe("useWatchedRunReading — what a console reads off the watched run", () => {
  it("reads the source path, the selected row and the root display status", async () => {
    const client = stubClient({ files: FILES });
    const { result } = renderHook(() => useWatchedRunReading(client, watched()));

    expect(result.current.rootWorkflowPath).toBe(ROOT);
    expect(result.current.selectedRun).toMatchObject({ runId: "leaf-1" });
    expect(result.current.rootStatus).toBe("running");

    await waitFor(() => expect(result.current.runFiles.rootFile?.name).toBe("main"));
    expect(result.current.rootFile?.id).toBe("wf");
  });

  it("prefers the run's recorded path over a surface's fallback", () => {
    const client = stubClient({ files: FILES });
    const { result } = renderHook(() =>
      useWatchedRunReading(client, watched(), "flows/other.workflow.json"),
    );
    expect(result.current.rootWorkflowPath).toBe(ROOT);
  });

  it("starts from the fallback path before a run row lands", () => {
    const client = stubClient({ files: FILES });
    const idle: WatchedRun = { ...watched(), load: { phase: "idle" } };
    const { result } = renderHook(() => useWatchedRunReading(client, idle, ROOT));
    expect(result.current.rootWorkflowPath).toBe(ROOT);
    expect(result.current.rootStatus).toBeNull();
    expect(result.current.selectedRun).toBeUndefined();
  });

  it("carries the server's display status over the stored one (ADR 0038)", () => {
    const client = stubClient({ files: FILES });
    const displayStatus = new Map([["root-1", "awaiting" as const]]);
    const { result } = renderHook(() =>
      useWatchedRunReading(client, watched({ displayStatus } as Partial<RunViewState>)),
    );
    expect(result.current.rootStatus).toBe("awaiting");
  });
});
