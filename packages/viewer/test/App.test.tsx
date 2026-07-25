import { PathApiClient, type FetchLike } from "@path/client-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

/** A `fetch` stub that answers `GET /v0/runs` with a fixed payload — the seam under test. */
function stubFetch(body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("App smoke screen", () => {
  it("lists root runs from the client-core seam", async () => {
    const client = new PathApiClient({
      baseUrl: "",
      fetch: stubFetch({
        runs: [{ run_id: "run_abc", status: "succeeded", started_at: null, finished_at: null }],
      }),
    });

    render(<App client={client} />);

    expect(await screen.findByText("run_abc")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
  });

  it("shows an error when the API call fails", async () => {
    const client = new PathApiClient({
      baseUrl: "",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });

    render(<App client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
