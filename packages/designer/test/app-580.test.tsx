import type { TemplateSummary } from "@path/client-core";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #580: author mode. Opening a `*.workflow-template.json` itself (its palette card's Edit button) edits
 * the template source, and three save doors apply (ADR 0049 decision 8, ADR 0050):
 *
 * - Save writes back to the original through `PUT /v0/templates/:id`, id preserved, under `If-Match`;
 * - Save as template creates a new `*.workflow-template.json` through `POST /v0/templates`, fresh id;
 * - Save as workflow runs Instantiation and creates a `*.workflow.json` through `PUT /v0/workflows`.
 *
 * A shipped template refuses the write-back with the API's `403`.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-5555-4555-8555-555555555555`;
}

const USER_ID = uuid(1);
const SHIPPED_ID = uuid(2);
const NODE_IDS = [uuid(3), uuid(4)];

function templateWorkflow(id: string): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id,
    name: "nightly",
    input: { ticket: "PATH-1" },
    body: [
      { type: "prompt", id: NODE_IDS[0], name: "draft", prompt: "draft it" },
      { type: "prompt", id: NODE_IDS[1], name: "judge", prompt: "judge it" },
    ],
  };
}

function summary(id: string, origin: "user" | "shipped"): TemplateSummary {
  const name = origin === "user" ? "nightly" : "starter";
  return { id, name, description: `${name} blurb`, kind: "workflow", origin, read_only: origin === "shipped", valid: true, error: null };
}

function envelope(id: string, origin: "user" | "shipped"): Record<string, unknown> {
  const { id: _id, ...rest } = summary(id, origin);
  return { id, ...rest, format: FORMAT_VERSION, body: templateWorkflow(id), etag: '"t"' };
}

const WORKFLOW_PATH = "flows/main.workflow.json";
const WORKFLOW_FILE = {
  format: FORMAT_VERSION,
  id: uuid(20),
  name: "flow",
  body: [{ type: "prompt", id: uuid(21), name: "alpha", prompt: "a" }],
};

function renderApp(initialPath?: string) {
  const calls = makeCalls();
  render(
    <App
      client={stubClient({
        files: { [WORKFLOW_PATH]: JSON.stringify(WORKFLOW_FILE) },
        templates: { templates: [summary(USER_ID, "user"), summary(SHIPPED_ID, "shipped")] },
        templateBodies: { [USER_ID]: envelope(USER_ID, "user"), [SHIPPED_ID]: envelope(SHIPPED_ID, "shipped") },
        calls,
      })}
      initialPath={initialPath}
    />,
  );
  return calls;
}

function templatesPanel(): HTMLElement {
  const palette = screen.getByRole("region", { name: "Palette" });
  fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
  return within(palette).getByRole("tabpanel", { name: "Templates" });
}

/** Open a template source in author mode through its card's Edit button, and wait for its nodes. */
async function editTemplate(stem: string): Promise<HTMLElement> {
  fireEvent.click(await within(templatesPanel()).findByRole("button", { name: `Edit ${stem}.workflow-template.json` }));
  const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
  await within(canvas).findByText("draft");
  return canvas;
}

describe("Author mode on a *.workflow-template.json (#580)", () => {
  it("opens the template source in author mode, named by its suffix", async () => {
    renderApp();
    await editTemplate("nightly");

    expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly.workflow-template.json");
    expect(screen.getByRole("button", { name: "Save as template…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as workflow…" })).toBeInTheDocument();
  });

  it("does not enter author mode for a *.workflow.json", async () => {
    renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");

    expect(screen.queryByTestId("author-mode")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as template…" })).not.toBeInTheDocument();
  });

  it("Save writes back to the original template, id preserved, under If-Match", async () => {
    const calls = renderApp();
    const canvas = await editTemplate("nightly");

    fireEvent.click(within(canvas).getByRole("button", { name: "Move draft down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved.");
    expect(calls.templateWrites).toHaveLength(1);
    const write = calls.templateWrites[0]!;
    expect(write).toMatchObject({ method: "PUT", id: USER_ID, ifMatch: '"t"' });
    expect(write.body["id"]).toBe(USER_ID);
    expect((write.body["body"] as { id: string }[]).map((node) => node.id)).toEqual([NODE_IDS[1], NODE_IDS[0]]);
    expect(calls.put).toHaveLength(0);
  });

  it("Save as template creates a new *.workflow-template.json with a fresh id, then edits it", async () => {
    const calls = renderApp();
    const canvas = await editTemplate("nightly");

    fireEvent.click(screen.getByRole("button", { name: "Save as template…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as new template" });
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "nightly-v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly-v2.workflow-template.json"));
    const post = calls.templateWrites[0]!;
    expect(post).toMatchObject({ method: "POST", id: null, body: { kind: "workflow", name: "nightly-v2" } });
    const created = post.body["body"] as { id: string; input: unknown };
    expect(created.id).not.toBe(USER_ID);
    expect(created.input).toEqual({ ticket: "PATH-1" });

    // The editor now writes back to the new template, under the create's ETag.
    fireEvent.click(within(canvas).getByRole("button", { name: "Move draft down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.templateWrites).toHaveLength(2));
    expect(calls.templateWrites[1]).toMatchObject({ method: "PUT", id: created.id, ifMatch: '"created"' });
  });

  it("Save as workflow runs Instantiation and writes a *.workflow.json", async () => {
    const calls = renderApp();
    await editTemplate("nightly");

    fireEvent.click(screen.getByRole("button", { name: "Save as workflow…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    expect(within(dialog).getByLabelText("Filename")).toHaveValue("nightly");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    const { workflow_path, workflow } = calls.put[0]!.body;
    expect(calls.put[0]!.ifMatch).toBeNull();
    expect(workflow_path).toBe("nightly.workflow.json");
    expect(workflow["id"]).not.toBe(USER_ID);
    expect(workflow["input"]).toEqual({ ticket: "PATH-1" });
    const saved = JSON.stringify(workflow);
    for (const id of NODE_IDS) expect(saved).not.toContain(id);
    expect(calls.templateWrites).toHaveLength(0);
    // The editor is now on the saved workflow, out of author mode.
    await waitFor(() => expect(screen.queryByTestId("author-mode")).not.toBeInTheDocument());
  });

  it("a shipped template refuses the write-back with the API's 403", async () => {
    const calls = renderApp();
    const canvas = await editTemplate("starter");
    expect(screen.getByTestId("author-mode")).toHaveTextContent("read-only");

    fireEvent.click(within(canvas).getByRole("button", { name: "Move draft down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/template is read-only/)).toBeInTheDocument();
    expect(calls.templateWrites).toEqual([expect.objectContaining({ method: "PUT", id: SHIPPED_ID })]);
  });
});
