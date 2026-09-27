import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { DEFAULT_PLUGINS, stubClient } from "@path/client-core/test-utils";
import { FORMAT_VERSION } from "@path/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { openedResultOf, useOpenFile } from "../src/use-open-file.js";

/**
 * A read the author asked for before the step-plugin registry landed is queued, not dropped. The
 * registry parses what a read returns, so the session waits for it rather than discarding the open
 * — the deep-link case, and any descend taken during startup.
 */

const PATH = "flows/main.workflow.json";

function canonicalFile(): string {
  const result = openWorkflowFile(
    JSON.stringify({
      format: FORMAT_VERSION,
      id: "00000000-0000-4000-8000-000000000001",
      name: "flow",
      body: [
        { type: "prompt", id: "00000000-0000-4000-8000-000000000002", name: "hi", prompt: "hi" },
      ],
    }),
    DEFAULT_PLUGINS,
  );
  if (result.status !== "opened") throw new Error(`fixture did not open: ${result.status}`);
  return canonicalSerialize(result.file);
}

/** A client whose registry read is held open until the test releases it. */
function deferredRegistryClient(files: Record<string, string>): {
  client: PathApiClient;
  release: (plugins: WireStepPlugin[]) => void;
} {
  const base = stubClient({ files });
  let release: (plugins: WireStepPlugin[]) => void = () => {};
  const registry = new Promise<{ step_plugins: WireStepPlugin[] }>((resolve) => {
    release = (plugins) => resolve({ step_plugins: plugins });
  });
  return {
    client: {
      getStepPlugins: () => registry,
      getWorkflowFile: (path: string) => base.getWorkflowFile(path),
    } as unknown as PathApiClient,
    release,
  };
}

describe("useOpenFile — a read waits for the registry", () => {
  it("queues the deep-link open until the registry lands, then lands it", async () => {
    const { client, release } = deferredRegistryClient({ [PATH]: canonicalFile() });
    const hook = renderHook(() => useOpenFile(client, PATH));

    // The registry is still out, so the open is queued: the frame exists in its loading state.
    await waitFor(() => expect(hook.result.current.frames).toHaveLength(1));
    expect(openedResultOf(hook.result.current.frames[0])).toBeNull();

    act(() => release(DEFAULT_PLUGINS));

    await waitFor(() => expect(openedResultOf(hook.result.current.frames[0])).not.toBeNull());
    expect(hook.result.current.registry.phase).toBe("ready");
  });

  it("opens a file applied straight after the registry lands", async () => {
    const { client, release } = deferredRegistryClient({ [PATH]: canonicalFile() });
    const hook = renderHook(() => useOpenFile(client));
    act(() => release(DEFAULT_PLUGINS));
    await waitFor(() => expect(hook.result.current.registry.phase).toBe("ready"));

    act(() => hook.result.current.apply({ type: "openLoading", path: PATH }));

    await waitFor(() => expect(openedResultOf(hook.result.current.frames[0])).not.toBeNull());
  });
});
