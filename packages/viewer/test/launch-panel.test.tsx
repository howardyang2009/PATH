import { PathApiClient, type FetchLike, type WorkflowSummary } from "@path/client-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LaunchPanel } from "../src/launch-panel.js";

const ROOT: WorkflowSummary = {
  relative_path: "release-notes.workflow.json",
  id: "8f1c",
  name: "release-notes",
  valid: true,
  is_root: true,
  error: null,
};
const NESTED: WorkflowSummary = {
  relative_path: "lib/draft.workflow.json",
  id: "c47e",
  name: "draft",
  valid: true,
  is_root: false,
  error: null,
};
const BROKEN: WorkflowSummary = {
  relative_path: "broken.workflow.json",
  id: null,
  name: null,
  valid: false,
  is_root: null,
  error: { message: "unexpected token } in JSON at position 142" },
};

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A client over a recording `fetch`: `GET /v0/workflows` answers `workflows`, `POST /v0/runs`
 * answers `startResponse` (a 202 body or, with `startStatus`, an error envelope). Every request is
 * captured so the launch body (`workflow_path`, `input`, `config`) is assertable.
 */
function stubClient(opts: {
  workflows: WorkflowSummary[];
  startResponse?: unknown;
  startStatus?: number;
}): { client: PathApiClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/v0/workflows") {
      return new Response(JSON.stringify({ workflows: opts.workflows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // POST /v0/runs
    return new Response(JSON.stringify(opts.startResponse ?? { run_id: "r_new", root_run_id: "r_new" }), {
      status: opts.startStatus ?? 202,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { client: new PathApiClient({ baseUrl: "", fetch }), calls };
}

function mount(client: PathApiClient, onLaunched = vi.fn()) {
  render(<LaunchPanel client={client} onLaunched={onLaunched} />);
  return { onLaunched };
}

describe("LaunchPanel", () => {
  it("lists discovered workflows as a folder tree, flagging roots; nested files sit under their folder", async () => {
    const { client } = stubClient({ workflows: [ROOT, NESTED] });
    mount(client);

    // A top-level file shows at the top level, flagged root.
    expect(await screen.findByTestId("workflow-row-release-notes.workflow.json")).toHaveTextContent("root");
    // A nested file is hidden until its folder is opened — the top level shows the folder, not the file.
    const folder = screen.getByTestId("workflow-folder-lib");
    expect(screen.queryByTestId("workflow-row-lib/draft.workflow.json")).toBeNull();

    fireEvent.click(folder);
    expect(screen.getByTestId("workflow-row-lib/draft.workflow.json")).toHaveTextContent("nested");
  });

  it("navigates folders as an accordion: opening one folder collapses the previously open sibling", async () => {
    const A: WorkflowSummary = { ...NESTED, relative_path: "alpha/one.workflow.json", name: "one" };
    const B: WorkflowSummary = { ...NESTED, relative_path: "beta/two.workflow.json", name: "two" };
    const { client } = stubClient({ workflows: [A, B] });
    mount(client);

    fireEvent.click(await screen.findByTestId("workflow-folder-alpha"));
    expect(screen.getByTestId("workflow-row-alpha/one.workflow.json")).toBeInTheDocument();

    // Opening beta collapses alpha (one open folder per level).
    fireEvent.click(screen.getByTestId("workflow-folder-beta"));
    expect(screen.getByTestId("workflow-row-beta/two.workflow.json")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-row-alpha/one.workflow.json")).toBeNull();

    // Clicking the open folder again collapses it.
    fireEvent.click(screen.getByTestId("workflow-folder-beta"));
    expect(screen.queryByTestId("workflow-row-beta/two.workflow.json")).toBeNull();
  });

  it("filters the list by kind: root / nested / invalid / all", async () => {
    const { client } = stubClient({ workflows: [ROOT, NESTED, BROKEN] });
    mount(client);

    await screen.findByTestId("workflow-row-release-notes.workflow.json");
    const filter = screen.getByLabelText("Kind");

    // root — only the root workflow survives; the nested file's folder drops out entirely.
    fireEvent.change(filter, { target: { value: "root" } });
    expect(screen.getByTestId("workflow-row-release-notes.workflow.json")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-folder-lib")).toBeNull();
    expect(screen.queryByTestId("workflow-row-broken.workflow.json")).toBeNull();

    // nested — only the nested ref, under its folder (open the folder to reach the row).
    fireEvent.change(filter, { target: { value: "nested" } });
    expect(screen.queryByTestId("workflow-row-release-notes.workflow.json")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-folder-lib"));
    expect(screen.getByTestId("workflow-row-lib/draft.workflow.json")).toBeInTheDocument();

    // invalid — only the invalid file (a top-level file, no folder).
    fireEvent.change(filter, { target: { value: "invalid" } });
    expect(screen.getByTestId("workflow-row-broken.workflow.json")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-row-release-notes.workflow.json")).toBeNull();

    // all — the top-level rows are back, and the nested file's folder returns.
    fireEvent.change(filter, { target: { value: "all" } });
    expect(screen.getByTestId("workflow-row-release-notes.workflow.json")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-folder-lib")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-row-broken.workflow.json")).toBeInTheDocument();
  });

  it("shows a kind-specific empty state when no workflow matches the filter", async () => {
    const { client } = stubClient({ workflows: [ROOT] });
    mount(client);

    await screen.findByTestId("workflow-row-release-notes.workflow.json");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "invalid" } });
    expect(screen.getByText("No invalid workflows.")).toBeInTheDocument();
  });

  it("keeps an invalid workflow's error off the row until the row is expanded, and offers no launch", async () => {
    const { client } = stubClient({ workflows: [BROKEN] });
    mount(client);

    const row = await screen.findByTestId("workflow-row-broken.workflow.json");
    // The error is not printed inline on the row.
    expect(row).not.toHaveTextContent(/unexpected token/);
    expect(screen.queryByTestId("workflow-error-broken.workflow.json")).toBeNull();

    // Clicking the row expands its error detail; clicking again collapses it.
    fireEvent.click(row);
    const detail = screen.getByTestId("workflow-error-broken.workflow.json");
    expect(detail).toHaveTextContent(/unexpected token/);
    // Still not launchable — an invalid file opens its error, never a launch form.
    expect(screen.queryByTestId("launch-form-broken.workflow.json")).toBeNull();

    fireEvent.click(row);
    expect(screen.queryByTestId("workflow-error-broken.workflow.json")).toBeNull();
  });

  it("expands an inline launch form under a clicked workflow, input prefilled with {}", async () => {
    const { client } = stubClient({ workflows: [ROOT] });
    mount(client);

    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    const input = screen.getByTestId("launch-input") as HTMLTextAreaElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("{}");
    // Config is optional and tucked behind a disclosure — not shown until asked for.
    expect(screen.queryByTestId("launch-config")).toBeNull();
  });

  it("reveals the config override textarea behind a disclosure", async () => {
    const { client } = stubClient({ workflows: [ROOT] });
    mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    fireEvent.click(screen.getByTestId("launch-config-toggle"));
    expect(screen.getByTestId("launch-config")).toBeInTheDocument();
  });

  it("blocks launch on client-side invalid JSON", async () => {
    const { client, calls } = stubClient({ workflows: [ROOT] });
    mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    fireEvent.change(screen.getByTestId("launch-input"), { target: { value: "{ not json" } });

    expect(screen.getByTestId("launch-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("launch-submit"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("launches: posts workflow_path + input, lifts the root_run_id, collapses the form", async () => {
    const { client, calls } = stubClient({
      workflows: [ROOT],
      startResponse: { run_id: "r_abc", root_run_id: "r_abc" },
    });
    const { onLaunched } = mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));
    fireEvent.change(screen.getByTestId("launch-input"), { target: { value: '{"ticket": 7}' } });

    fireEvent.click(screen.getByTestId("launch-submit"));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("r_abc"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/v0/runs");
    expect(post?.body).toEqual({ workflow_path: "release-notes.workflow.json", input: { ticket: 7 } });
    // 202 collapses the form.
    await waitFor(() => expect(screen.queryByTestId("launch-input")).toBeNull());
  });

  it("sends a config override in the launch body when one is supplied", async () => {
    const { client, calls } = stubClient({ workflows: [ROOT] });
    mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    fireEvent.click(screen.getByTestId("launch-config-toggle"));
    fireEvent.change(screen.getByTestId("launch-config"), {
      target: { value: '{"model": "claude"}' },
    });
    fireEvent.click(screen.getByTestId("launch-submit"));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      workflow_path: "release-notes.workflow.json",
      input: {},
      config: { model: "claude" },
    });
  });

  it("does not drop a typed config when the disclosure is collapsed before launch", async () => {
    const { client, calls } = stubClient({ workflows: [ROOT] });
    mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    fireEvent.click(screen.getByTestId("launch-config-toggle"));
    fireEvent.change(screen.getByTestId("launch-config"), { target: { value: '{"model": "claude"}' } });
    fireEvent.click(screen.getByTestId("launch-config-toggle")); // collapse again
    fireEvent.click(screen.getByTestId("launch-submit"));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ config: { model: "claude" } });
  });

  it("allows an empty input — launches, sending no input field", async () => {
    const { client, calls } = stubClient({ workflows: [ROOT] });
    mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));
    fireEvent.change(screen.getByTestId("launch-input"), { target: { value: "" } });

    fireEvent.click(screen.getByTestId("launch-submit"));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ workflow_path: "release-notes.workflow.json" });
  });

  it("surfaces a server 400 in the form without collapsing it", async () => {
    const { client } = stubClient({
      workflows: [ROOT],
      startStatus: 400,
      startResponse: { error: { message: "workflow validation failed" } },
    });
    const { onLaunched } = mount(client);
    fireEvent.click(await screen.findByTestId("workflow-row-release-notes.workflow.json"));

    fireEvent.click(screen.getByTestId("launch-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("workflow validation failed");
    expect(screen.getByTestId("launch-input")).toBeInTheDocument();
    expect(onLaunched).not.toHaveBeenCalled();
  });
});
