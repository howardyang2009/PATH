import { PathApiClient, type FetchLike, type RootRunSummary } from "@path/client-core";
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
  status: "succeeded",
  started_at: "2026-07-25T09:14:05.000Z",
  finished_at: "2026-07-25T09:14:31.000Z",
};

const RUNNING: RootRunSummary = {
  run_id: "run_beta",
  status: "running",
  started_at: "2026-07-25T09:20:00.000Z",
  finished_at: null,
};

function renderList(client: PathApiClient, overrides: Partial<Parameters<typeof RunsList>[0]> = {}) {
  return render(
    <RunsList
      client={client}
      selectedRootRunId={null}
      onSelectRootRun={() => {}}
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

  it("shows status as color + glyph, never hue alone", async () => {
    const { client } = stubClient([RUNNING, SUCCEEDED]);

    renderList(client);
    await screen.findByTestId("run-row-run_beta");

    expect(pillOf("run_beta")).toHaveTextContent("◐running");
    expect(pillOf("run_beta")).toHaveAttribute("data-status", "running");
    expect(pillOf("run_alpha")).toHaveTextContent("✓succeeded");
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
      <RunsList client={client} selectedRootRunId="run_alpha" onSelectRootRun={onSelect} />,
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

  it("distinguishes an empty filter result from an empty run store", async () => {
    const { client } = stubClient([]);

    renderList(client);
    await screen.findByText("No runs yet.");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });

    expect(await screen.findByText("No failed runs.")).toBeInTheDocument();
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
