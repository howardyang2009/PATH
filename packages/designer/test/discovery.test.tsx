import { type FetchLike, PathApiClient } from "@path/client-core";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { discoveredWorkflows, useWorkflowDiscovery } from "../src/discovery.js";
import type { SaveState } from "../src/session-reducer.js";

/**
 * The Designer's one discovery load (`discovery.ts`). The four consumers' projections are covered where
 * they render (the dialogs and the problems pass, through the App); these prove the load's own policy —
 * the `null`-versus-`[]` distinction, keep-last on failure, and one re-scan per save that lands.
 */

function clientOver(responses: (() => Promise<Response>)[]): {
  client: PathApiClient;
  calls: () => number;
} {
  let calls = 0;
  const fetch: FetchLike = () => responses[Math.min(calls++, responses.length - 1)]!();
  return { client: new PathApiClient({ baseUrl: "", fetch }), calls: () => calls };
}

const workflow = (relative_path: string) => ({ relative_path }) as never;

function ok(paths: string[]): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ workflows: paths.map(workflow) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

function fail(): Promise<Response> {
  return Promise.reject(new Error("offline"));
}

/** Render the hook with a save phase the test can change, the way the App's session drives it. */
function renderDiscovery(client: PathApiClient, phase: SaveState["phase"] = "idle") {
  return renderHook(
    ({ savePhase }: { savePhase: SaveState["phase"] }) => useWorkflowDiscovery(client, savePhase),
    {
      initialProps: { savePhase: phase },
    },
  );
}

describe("useWorkflowDiscovery", () => {
  it("is loading — not empty — until the first scan lands", async () => {
    const { client } = clientOver([ok(["a.workflow.json"])]);
    const hook = renderDiscovery(client);

    expect(hook.result.current.phase).toBe("loading");
    // `null`, not `[]`: a consumer must be able to tell "not scanned yet" from "none exist".
    expect(discoveredWorkflows(hook.result.current)).toBeNull();

    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    expect(discoveredWorkflows(hook.result.current)?.map((wf) => wf.relative_path)).toEqual([
      "a.workflow.json",
    ]);
  });

  it("reports a failed first scan, and still distinguishes it from an empty project", async () => {
    const { client } = clientOver([fail]);
    const hook = renderDiscovery(client);

    await waitFor(() => expect(hook.result.current.phase).toBe("error"));
    // No successful scan behind the failure: nothing discovered, so a dialog reads empty rather than hanging.
    expect(discoveredWorkflows(hook.result.current)).toBeNull();

    const empty = clientOver([ok([])]);
    const emptyHook = renderDiscovery(empty.client);
    await waitFor(() => expect(emptyHook.result.current.phase).toBe("ready"));
    expect(discoveredWorkflows(emptyHook.result.current)).toEqual([]);
  });

  it("keeps the last successful list when a later scan fails — a read blip must not empty the pickers", async () => {
    const { client } = clientOver([ok(["a.workflow.json"]), fail]);
    const hook = renderDiscovery(client);
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));

    hook.rerender({ savePhase: "saved" });

    await waitFor(() => expect(hook.result.current.phase).toBe("error"));
    expect(discoveredWorkflows(hook.result.current)?.map((wf) => wf.relative_path)).toEqual([
      "a.workflow.json",
    ]);
  });

  it("re-scans when a save lands, and not for the transient saving phase", async () => {
    const { client, calls } = clientOver([ok(["a.workflow.json"])]);
    const hook = renderDiscovery(client);
    await waitFor(() => expect(calls()).toBe(1));

    hook.rerender({ savePhase: "saving" });
    expect(calls()).toBe(1);

    hook.rerender({ savePhase: "saved" });
    await waitFor(() => expect(calls()).toBe(2));
  });
});
