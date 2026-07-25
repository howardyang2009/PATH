import { PathApiClient, type FetchLike } from "@path/client-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

/** A `fetch` stub that answers `GET /v0/runs` with a fixed payload — the seam under test. */
function stubFetch(body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("App", () => {
  it("frames the three panes of the pinned console layout", async () => {
    const client = new PathApiClient({ baseUrl: "", fetch: stubFetch({ runs: [] }) });

    render(<App client={client} />);

    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Run detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Node I/O" })).toBeInTheDocument();
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("owns the selected root run id and exposes it to the other panes", async () => {
    const client = new PathApiClient({
      baseUrl: "",
      fetch: stubFetch({
        runs: [{ run_id: "run_abc", status: "succeeded", started_at: null, finished_at: null }],
      }),
    });

    render(<App client={client} />);
    fireEvent.click(await screen.findByTestId("run-row-run_abc"));

    expect(screen.getByRole("region", { name: "Run detail" })).toHaveTextContent("run_abc");
  });
});
