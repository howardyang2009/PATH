import {
  displayStatusByRun,
  type FetchLike,
  PathApiClient,
  PathApiError,
  type RootRunSummary,
  type RunNodeState,
} from "@path/client-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNS_REFRESH_MS, RunsList } from "../src/runs-list.js";

/**
 * A client over a recording `fetch` stub — the injected seam the surface is tested through
 * (`@path/client-core` owns the wire shapes; the view only formats them). `urls` captures every
 * request so query-parameter wiring (`limit`, `status`) is assertable.
 */
function stubClient(runs: RootRunSummary[]): { client: PathApiClient; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(input);
    return new Response(JSON.stringify({ runs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { client: new PathApiClient({ baseUrl: "", fetch }), urls };
}

const SUCCEEDED: RootRunSummary = {
  run_id: "run_alpha",
  workflow_name: "Build Report",
  workflow_id: "wf-alpha",
  workflow_path: "build-report.workflow.json",
  status: "succeeded",
  started_at: "2026-07-25T09:14:05.000Z",
  finished_at: "2026-07-25T09:14:31.000Z",
};

const RUNNING: RootRunSummary = {
  run_id: "run_beta",
  workflow_name: "Nightly Sync",
  workflow_id: "wf-beta",
  workflow_path: "nightly-sync.workflow.json",
  status: "running",
  started_at: "2026-07-25T09:20:00.000Z",
  finished_at: null,
};

const CANCELLED: RootRunSummary = {
  run_id: "run_gamma",
  workflow_name: null,
  workflow_id: null,
  workflow_path: null,
  status: "cancelled",
  started_at: "2026-07-25T09:25:00.000Z",
  finished_at: "2026-07-25T09:25:40.000Z",
};

const FAILED: RootRunSummary = {
  run_id: "run_delta",
  workflow_name: "Deploy Pipeline",
  workflow_id: "wf-delta",
  workflow_path: "deploy.workflow.json",
  status: "failed",
  started_at: "2026-07-25T09:30:00.000Z",
  finished_at: "2026-07-25T09:30:12.000Z",
};

/**
 * A run-tree node rooted at run_beta, defaulting every field so a test overrides only what it asserts
 * on — the same shape the awaiting-pill test builds inline, hoisted so the in-flight tests reuse it.
 */
function awaitingNode(over: Partial<RunNodeState> & { runId: string }): RunNodeState {
  return {
    rootRunId: "run_beta",
    parentRunId: "run_beta",
    nodeId: over.runId,
    nodeName: over.runId,
    workerName: null,
    iteration: null,
    pass: null,
    status: "running",
    startedAt: null,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    rerunFromNodePath: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...over,
  };
}

function renderList(
  client: PathApiClient,
  overrides: Partial<Parameters<typeof RunsList>[0]> = {},
) {
  return render(
    <RunsList
      client={client}
      selectedRootRunId={null}
      onSelectRootRun={() => {}}
      onResumed={() => {}}
      onDeleted={() => {}}
      {...overrides}
    />,
  );
}

/** The status pill inside one run's row — reached through the row, as a reader reaches it. */
function pillOf(rootRunId: string): HTMLElement {
  const pill = screen.getByTestId(`run-row-${rootRunId}`).querySelector(".pill");
  if (pill === null) throw new Error(`no status pill in the row for ${rootRunId}`);
  return pill as HTMLElement;
}

describe("RunsList", () => {
  it("renders one row per root run, most recent first as the server returns them", async () => {
    const { client } = stubClient([RUNNING, SUCCEEDED]);

    renderList(client);

    const rows = await screen.findAllByRole("button", { name: /run_/ });
    expect(rows.map((row) => row.getAttribute("data-run-id"))).toEqual(["run_beta", "run_alpha"]);
  });

  it("shows the workflow name on each row, falling back to — when the run has none", async () => {
    const { client } = stubClient([RUNNING, CANCELLED]);

    renderList(client);
    await screen.findByTestId("run-row-run_beta");

    expect(screen.getByTestId("run-row-run_beta").querySelector(".run-workflow")).toHaveTextContent(
      "Nightly Sync",
    );
    // CANCELLED has workflow_name: null — the em dash placeholder stands in.
    expect(
      screen.getByTestId("run-row-run_gamma").querySelector(".run-workflow"),
    ).toHaveTextContent("—");
  });

  it("shows status as color + glyph, never hue alone", async () => {
    const { client } = stubClient([RUNNING, SUCCEEDED]);

    renderList(client);
    await screen.findByTestId("run-row-run_beta");

    expect(pillOf("run_beta")).toHaveTextContent("◐running");
    expect(pillOf("run_beta")).toHaveAttribute("data-status", "running");
    expect(pillOf("run_alpha")).toHaveTextContent("✓succeeded");
    expect(pillOf("run_alpha")).toHaveAttribute("data-status", "succeeded");
  });

  it("paints the watched root awaiting when the view publishes that display status (record stays running)", async () => {
    const { client } = stubClient([RUNNING, SUCCEEDED]);
    // The app hands the watched run's published display status — the shared derivation run over the
    // watched tree — so run_beta (running) has a parked leaf and reads awaiting; its summary status
    // stays running, and a row the view does not hold keeps its summary status.
    const runs = new Map<string, RunNodeState>([
      ["run_beta", awaitingNode({ runId: "run_beta", parentRunId: null, status: "running" })],
      ["leaf", awaitingNode({ runId: "leaf", parentRunId: "run_beta", status: "awaiting" })],
    ]);

    renderList(client, { selectedRootRunId: "run_beta", displayStatus: displayStatusByRun(runs) });
    await screen.findByTestId("run-row-run_beta");

    expect(pillOf("run_beta")).toHaveAttribute("data-status", "awaiting");
    // A row the app is not watching has no tree, so it keeps its record status.
    expect(pillOf("run_alpha")).toHaveAttribute("data-status", "succeeded");
  });

  it("shows a loading state until the runs arrive", async () => {
    const client = new PathApiClient({ baseUrl: "", fetch: () => new Promise<Response>(() => {}) });

    renderList(client);

    expect(screen.getByText("Loading runs…")).toBeInTheDocument();
  });

  it("shows an empty state when the server has no runs", async () => {
    const { client } = stubClient([]);

    renderList(client);

    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("surfaces the API error message", async () => {
    const client = new PathApiClient({
      baseUrl: "",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "run store is locked" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });

    renderList(client);

    expect(await screen.findByRole("alert")).toHaveTextContent("run store is locked");
  });

  it("lifts the clicked run id and marks that row selected", async () => {
    const { client } = stubClient([RUNNING, SUCCEEDED]);
    const onSelect = vi.fn();

    const { rerender } = renderList(client, { onSelectRootRun: onSelect });
    fireEvent.click(await screen.findByTestId("run-row-run_alpha"));

    expect(onSelect).toHaveBeenCalledWith("run_alpha");

    rerender(
      <RunsList
        client={client}
        selectedRootRunId="run_alpha"
        onSelectRootRun={onSelect}
        onResumed={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.getByTestId("run-row-run_alpha")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("run-row-run_beta")).not.toHaveAttribute("aria-current");
  });

  it("caps the request at the pane's limit and refetches when the status filter changes", async () => {
    const { client, urls } = stubClient([RUNNING]);

    renderList(client);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe("/v0/runs?limit=50");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe("/v0/runs?limit=50&status=failed");
  });

  it("re-reads immediately when the reload nonce changes, without a loading flash", async () => {
    const { client, urls } = stubClient([RUNNING]);

    const { rerender } = renderList(client, { reloadNonce: 0 });
    await waitFor(() => expect(urls).toHaveLength(1));

    rerender(
      <RunsList
        client={client}
        selectedRootRunId={null}
        onSelectRootRun={() => {}}
        onResumed={() => {}}
        onDeleted={() => {}}
        reloadNonce={1}
      />,
    );

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(screen.queryByText("Loading runs…")).toBeNull();
  });

  it("distinguishes an empty filter result from an empty run store", async () => {
    const { client } = stubClient([]);

    renderList(client);
    await screen.findByText("No runs yet.");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });

    expect(await screen.findByText("No failed runs.")).toBeInTheDocument();
  });

  // Resume (§4.3) lives here, expanded under a run's row — the rail's mirror of the launch form
  // under a workflow row: a click opens it, a second click closes it (single-open), and only a
  // finished-but-unsuccessful row offers it at all.
  describe("resume affordance", () => {
    it.each([CANCELLED, FAILED])(
      "expands Resume under a %s row when it is clicked",
      async (run) => {
        const { client } = stubClient([run]);
        renderList(client);

        fireEvent.click(await screen.findByTestId(`run-row-${run.run_id}`));
        expect(await screen.findByTestId("resume-button")).toHaveTextContent("Resume run");
      },
    );

    it("collapses the Resume expand when the same row is clicked again (toggle)", async () => {
      const { client } = stubClient([CANCELLED]);
      renderList(client);

      const row = await screen.findByTestId(`run-row-${CANCELLED.run_id}`);
      fireEvent.click(row);
      expect(await screen.findByTestId("resume-button")).toBeInTheDocument();

      fireEvent.click(row);
      expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
    });

    it("shows Resume greyed, not hidden, when a succeeded row is clicked", async () => {
      const { client } = stubClient([SUCCEEDED]);
      renderList(client);

      fireEvent.click(await screen.findByTestId(`run-row-${SUCCEEDED.run_id}`));
      const button = await screen.findByTestId("resume-button");
      expect(button).toHaveTextContent("Resume run");
      expect(button).toBeDisabled();
    });

    it("offers no Resume when a running row is clicked", async () => {
      const { client } = stubClient([RUNNING]);
      renderList(client);

      fireEvent.click(await screen.findByTestId(`run-row-${RUNNING.run_id}`));
      expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
    });

    it("does not expand a row's Resume until it is clicked", async () => {
      const { client } = stubClient([CANCELLED]);
      renderList(client);

      await screen.findByTestId(`run-row-${CANCELLED.run_id}`);
      expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
    });

    it("resumes the run and hands the successor up to the app", async () => {
      const { client } = stubClient([CANCELLED]);
      vi.spyOn(client, "resumeRun").mockResolvedValue({
        run_id: "successor",
        root_run_id: "successor",
      });
      const onResumed = vi.fn();
      renderList(client, { onResumed });

      fireEvent.click(await screen.findByTestId(`run-row-${CANCELLED.run_id}`));
      fireEvent.click(await screen.findByTestId("resume-button"));

      await waitFor(() => expect(onResumed).toHaveBeenCalledWith("successor"));
    });

    it("forwards a typed config override to resumeRun", async () => {
      const { client } = stubClient([FAILED]);
      const resumeRun = vi.spyOn(client, "resumeRun").mockReturnValue(new Promise(() => {}));
      renderList(client);

      fireEvent.click(await screen.findByTestId(`run-row-${FAILED.run_id}`));
      fireEvent.click(screen.getByTestId("resume-config-toggle")); // reveal the optional field
      fireEvent.change(screen.getByTestId("resume-config"), {
        target: { value: '{"output_file":"OUT.md"}' },
      });
      fireEvent.click(screen.getByTestId("resume-button"));

      expect(resumeRun).toHaveBeenCalledWith(FAILED.run_id, { output_file: "OUT.md" });
    });

    it("prefills and sends the launch-secret config for a run whose summary carries launch_secret_keys (ADR 0046)", async () => {
      const withSecrets: RootRunSummary = { ...FAILED, launch_secret_keys: ["github.token"] };
      const { client } = stubClient([withSecrets]);
      const resumeRun = vi.spyOn(client, "resumeRun").mockReturnValue(new Promise(() => {}));
      renderList(client);

      fireEvent.click(await screen.findByTestId(`run-row-${withSecrets.run_id}`));
      // Prefilled and open: the masked paths are visible without opening the disclosure first.
      const field = (await screen.findByTestId("resume-config")) as HTMLTextAreaElement;
      expect(JSON.parse(field.value)).toEqual({ github: { token: "" } });
      expect(screen.getByTestId("resume-config-note")).toHaveTextContent(/masked/i);

      fireEvent.change(field, { target: { value: '{"github":{"token":"sk-live"}}' } });
      fireEvent.click(screen.getByTestId("resume-button"));

      expect(resumeRun).toHaveBeenCalledWith(withSecrets.run_id, { github: { token: "sk-live" } });
    });

    it("disables Resume run and names the blank launch secret until it is supplied (ADR 0046)", async () => {
      const withSecrets: RootRunSummary = { ...FAILED, launch_secret_keys: ["DEEPSEEK_API_KEY"] };
      const { client } = stubClient([withSecrets]);
      const resumeRun = vi.spyOn(client, "resumeRun").mockReturnValue(new Promise(() => {}));
      renderList(client);

      // The skeleton arrives on screen blank, so the verb is greyed with its reason from the start —
      // the same rule the Complete form applies to the other continuation door.
      fireEvent.click(await screen.findByTestId(`run-row-${withSecrets.run_id}`));
      const button = await screen.findByTestId("resume-button");
      expect(button).toBeDisabled();
      expect(screen.getByTestId("resume-secret-error")).toHaveTextContent('"DEEPSEEK_API_KEY"');

      fireEvent.click(button);
      expect(resumeRun).not.toHaveBeenCalled();

      // A whitespace-only value is no more a credential than an empty one.
      fireEvent.change(screen.getByTestId("resume-config"), {
        target: { value: '{"DEEPSEEK_API_KEY":"   "}' },
      });
      expect(screen.getByTestId("resume-button")).toBeDisabled();
      expect(screen.getByTestId("resume-secret-error")).toHaveTextContent('"DEEPSEEK_API_KEY"');

      // Supplied, the reason clears and the verb is live again.
      fireEvent.change(screen.getByTestId("resume-config"), {
        target: { value: '{"DEEPSEEK_API_KEY":"sk-live"}' },
      });
      expect(screen.queryByTestId("resume-secret-error")).toBeNull();
      fireEvent.click(screen.getByTestId("resume-button"));

      expect(resumeRun).toHaveBeenCalledWith(withSecrets.run_id, { DEEPSEEK_API_KEY: "sk-live" });
    });

    it("surfaces a resume error rather than claiming it was sent", async () => {
      const { client } = stubClient([FAILED]);
      vi.spyOn(client, "resumeRun").mockRejectedValue(new PathApiError(409, "already succeeded"));
      const onResumed = vi.fn();
      renderList(client, { onResumed });

      fireEvent.click(await screen.findByTestId(`run-row-${FAILED.run_id}`));
      const button = await screen.findByTestId("resume-button");
      fireEvent.click(button);

      expect(await screen.findByRole("alert")).toHaveTextContent("already succeeded");
      expect(button).toHaveTextContent("Resume run");
      expect(onResumed).not.toHaveBeenCalled();
    });
  });

  // Delete (§ DELETE /v0/runs/:id) lives in the same expanded panel as Resume. It is offered on every
  // finished row — succeeded as well as cancelled/failed — but not on a run still in flight, which the
  // server would 409 anyway. It is two-step: an arm, then a confirm that spells out which run goes.
  describe("delete affordance", () => {
    it.each([SUCCEEDED, CANCELLED, FAILED])(
      "offers Delete when a %s row is clicked",
      async (run) => {
        const { client } = stubClient([run]);
        renderList(client);

        fireEvent.click(await screen.findByTestId(`run-row-${run.run_id}`));
        expect(await screen.findByTestId("delete-arm")).toBeInTheDocument();
      },
    );

    it("arms a confirmation showing the run's identity, then deletes and notifies the app", async () => {
      const { client } = stubClient([SUCCEEDED]);
      const deleteRun = vi.spyOn(client, "deleteRun").mockResolvedValue();
      const onDeleted = vi.fn();
      renderList(client, { onDeleted });

      fireEvent.click(await screen.findByTestId(`run-row-${SUCCEEDED.run_id}`));
      fireEvent.click(await screen.findByTestId("delete-arm"));

      // The confirm spells out exactly which run will be deleted.
      const identity = screen.getByTestId("delete-identity");
      expect(identity).toHaveTextContent(SUCCEEDED.run_id);
      expect(identity).toHaveTextContent("Build Report");
      expect(identity).toHaveTextContent("wf-alpha");
      expect(identity).toHaveTextContent("build-report.workflow.json");

      fireEvent.click(screen.getByTestId("delete-confirm"));
      expect(deleteRun).toHaveBeenCalledWith(SUCCEEDED.run_id);
      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(SUCCEEDED.run_id));
    });

    it("backs out of an armed delete without sending anything (Keep)", async () => {
      const { client } = stubClient([SUCCEEDED]);
      const deleteRun = vi.spyOn(client, "deleteRun").mockResolvedValue();
      renderList(client);

      fireEvent.click(await screen.findByTestId(`run-row-${SUCCEEDED.run_id}`));
      fireEvent.click(await screen.findByTestId("delete-arm"));
      fireEvent.click(screen.getByTestId("delete-keep"));

      expect(screen.queryByTestId("delete-identity")).toBeNull();
      expect(screen.getByTestId("delete-arm")).toBeInTheDocument();
      expect(deleteRun).not.toHaveBeenCalled();
    });

    it("surfaces a delete error rather than claiming it was removed", async () => {
      const { client } = stubClient([CANCELLED]);
      vi.spyOn(client, "deleteRun").mockRejectedValue(
        new PathApiError(409, "a live successor still reuses its data"),
      );
      const onDeleted = vi.fn();
      renderList(client, { onDeleted });

      fireEvent.click(await screen.findByTestId(`run-row-${CANCELLED.run_id}`));
      fireEvent.click(await screen.findByTestId("delete-arm"));
      fireEvent.click(screen.getByTestId("delete-confirm"));

      expect(await screen.findByRole("alert")).toHaveTextContent("still reuses its data");
      expect(onDeleted).not.toHaveBeenCalled();
    });
  });

  // A run still in flight — running, or a running root reading awaiting because a leaf is parked
  // (ADR 0038) — offers none of the three run actions. The panel says why instead of standing empty.
  describe("in-flight run actions", () => {
    it("offers no Resume, Resume from …, or Delete when a running row is clicked", async () => {
      const { client } = stubClient([RUNNING]);
      // The affordance present and this row selected is the one case that would otherwise show
      // `Resume from …`; it must still stay hidden because the run is in flight.
      renderList(client, {
        selectedRootRunId: RUNNING.run_id,
        resumeFrom: { runs: new Map(), selectedRunId: null, rootFile: null, dirty: false },
      });

      fireEvent.click(await screen.findByTestId(`run-row-${RUNNING.run_id}`));
      await screen.findByTestId(`run-actions-${RUNNING.run_id}`);

      expect(screen.queryByTestId("resume-button")).toBeNull();
      expect(screen.queryByTestId("resume-from-submit")).toBeNull();
      expect(screen.queryByTestId("delete-arm")).toBeNull();
      expect(screen.getByTestId(`run-actions-${RUNNING.run_id}`)).toHaveTextContent(
        "still in flight",
      );
    });

    it("offers no actions when a running root reads awaiting through its parked leaf", async () => {
      const { client } = stubClient([RUNNING]);
      const runs = new Map<string, RunNodeState>([
        ["run_beta", awaitingNode({ runId: "run_beta", parentRunId: null, status: "running" })],
        ["leaf", awaitingNode({ runId: "leaf", parentRunId: "run_beta", status: "awaiting" })],
      ]);
      // The affordance present and this row selected is the one case that would otherwise offer
      // `Resume from …`; the published display status is what makes the row read in flight.
      renderList(client, {
        selectedRootRunId: "run_beta",
        resumeFrom: { runs, selectedRunId: null, rootFile: null, dirty: false },
        displayStatus: displayStatusByRun(runs),
      });

      fireEvent.click(await screen.findByTestId(`run-row-run_beta`));
      await screen.findByTestId("run-actions-run_beta");

      expect(pillOf("run_beta")).toHaveAttribute("data-status", "awaiting");
      expect(screen.queryByTestId("resume-button")).toBeNull();
      expect(screen.queryByTestId("resume-from-submit")).toBeNull();
      expect(screen.queryByTestId("delete-arm")).toBeNull();
    });
  });
});

/**
 * `GET /v0/runs` is a one-shot read and there is no stream of *all* runs, so the pane re-reads on an
 * interval (#50). Without it the rail contradicts the live centre pane: a run that has finished
 * still reads `running`, and a run launched after page load never appears.
 */
describe("RunsList refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance past one refresh tick, letting the re-read's promises settle inside `act`. */
  async function tick(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNS_REFRESH_MS);
    });
  }

  it("re-reads the list, so a run that has finished stops reading as running", async () => {
    const runs = [{ ...RUNNING }];
    const { client } = stubClient(runs);

    renderList(client);
    await act(async () => {});
    expect(pillOf(RUNNING.run_id)).toHaveTextContent("running");

    runs[0] = { ...RUNNING, status: "succeeded", finished_at: "2026-07-25T09:20:31.000Z" };
    await tick();

    expect(pillOf(RUNNING.run_id)).toHaveTextContent("succeeded");
  });

  it("picks up a run launched after the page loaded", async () => {
    const runs = [{ ...SUCCEEDED }];
    const { client } = stubClient(runs);

    renderList(client);
    await act(async () => {});
    expect(screen.queryByTestId(`run-row-${RUNNING.run_id}`)).toBeNull();

    runs.unshift({ ...RUNNING });
    await tick();

    expect(screen.getByTestId(`run-row-${RUNNING.run_id}`)).toBeInTheDocument();
  });

  it("keeps the rendered rows on screen while re-reading — no loading flash", async () => {
    const { client } = stubClient([RUNNING]);

    renderList(client);
    await act(async () => {});

    await tick();

    expect(screen.queryByText("Loading runs…")).toBeNull();
    expect(screen.getByTestId(`run-row-${RUNNING.run_id}`)).toBeInTheDocument();
  });

  it("reports a refresh that fails rather than leaving a frozen list looking healthy", async () => {
    let fail = false;
    const fetch: FetchLike = async () => {
      if (fail) throw new Error("connection refused");
      return new Response(JSON.stringify({ runs: [RUNNING] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    renderList(new PathApiClient({ baseUrl: "", fetch }));
    await act(async () => {});

    fail = true;
    await tick();

    expect(screen.getByRole("alert")).toHaveTextContent("connection refused");
  });

  it("stops re-reading once the pane unmounts", async () => {
    const { client, urls } = stubClient([RUNNING]);

    const view = renderList(client);
    await act(async () => {});
    expect(urls).toHaveLength(1);

    view.unmount();
    await tick();

    expect(urls).toHaveLength(1);
  });
});
