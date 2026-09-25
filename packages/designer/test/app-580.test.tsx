import type { TemplateSummary } from "@path/client-core";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #580: author mode. Opening a `*.workflow-template.json` itself (a double-click on its palette card)
 * edits the template source, and two save doors apply (ADR 0049 decision 8, ADR 0050):
 *
 * - Save writes back to the original through `PUT /v0/templates/:id`, id preserved, under `If-Match`;
 * - Save as… creates a new `*.workflow-template.json` through `POST /v0/templates`, fresh id.
 *
 * A template saves only as a template: there is no Save as workflow door. A shipped template refuses the
 * write-back with the API's `403`. A `*.step-template.json` opens the same way, inside a synthetic
 * workflow; its Save writes back the step-template envelope.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-5555-4555-8555-555555555555`;
}

const USER_ID = uuid(1);
const SHIPPED_ID = uuid(2);
const NODE_IDS = [uuid(3), uuid(4)];
const STEP_ID = uuid(5);
const BROKEN_ID = uuid(6);

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

const STEP_SUMMARY: TemplateSummary = {
  id: STEP_ID,
  name: "draft-judge",
  description: "draft then judge",
  kind: "step",
  origin: "user",
  read_only: false,
  valid: true,
  error: null,
};

const STEP_ENVELOPE = {
  ...STEP_SUMMARY,
  format: FORMAT_VERSION,
  body: templateWorkflow(STEP_ID)["body"],
  etag: '"s"',
};

const BROKEN_SUMMARY: TemplateSummary = {
  ...summary(BROKEN_ID, "user"),
  name: "broken",
  valid: false,
  error: { message: "template validation failed" },
};

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
        templates: { templates: [summary(USER_ID, "user"), summary(SHIPPED_ID, "shipped"), STEP_SUMMARY, BROKEN_SUMMARY] },
        templateBodies: {
          [USER_ID]: envelope(USER_ID, "user"),
          [SHIPPED_ID]: envelope(SHIPPED_ID, "shipped"),
          [STEP_ID]: STEP_ENVELOPE,
          [BROKEN_ID]: { ...envelope(BROKEN_ID, "user"), name: "broken" },
        },
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

/** Open a template source in author mode with a double-click on its card, and wait for its nodes. */
async function editTemplate(stem: string): Promise<HTMLElement> {
  // A double-click edits only in template mode; switching from an empty workflow canvas asks nothing.
  const mode = await screen.findByRole("radiogroup", { name: "Edit mode" });
  fireEvent.click(within(mode).getByRole("radio", { name: "Template" }));
  fireEvent.doubleClick(await within(templatesPanel()).findByRole("button", { name: new RegExp(`^${stem}`) }));
  const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
  await within(canvas).findByText("draft");
  return canvas;
}

describe("Author mode on a *.workflow-template.json (#580)", () => {
  it("opens the template source in author mode, named by its suffix", async () => {
    renderApp();
    await editTemplate("nightly");

    expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly.workflow-template.json");
    expect(screen.getByRole("button", { name: "Save as…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as workflow…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
  });

  it("opens an invalid template on double-click, so the author can repair it", async () => {
    renderApp();
    await editTemplate("broken");

    expect(screen.getByTestId("author-mode")).toHaveTextContent("broken.workflow-template.json");
  });

  it("does not enter author mode for a *.workflow.json", async () => {
    renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");

    expect(screen.queryByTestId("author-mode")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as workflow…" })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
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

describe("Author mode on a *.step-template.json", () => {
  it("opens the step-template body on the canvas", async () => {
    renderApp();
    await editTemplate("draft-judge");

    expect(screen.getByTestId("author-mode")).toHaveTextContent("draft-judge.step-template.json");
    expect(screen.getByRole("button", { name: "Save as…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as workflow…" })).not.toBeInTheDocument();
  });

  it("Save writes back the step-template envelope, id and description preserved", async () => {
    const calls = renderApp();
    const canvas = await editTemplate("draft-judge");

    fireEvent.click(within(canvas).getByRole("button", { name: "Move draft down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved.");
    const write = calls.templateWrites[0]!;
    expect(write).toMatchObject({ method: "PUT", id: STEP_ID, ifMatch: '"s"' });
    expect(Object.keys(write.body).sort()).toEqual(["body", "description", "format", "id"]);
    expect(write.body).toMatchObject({ format: FORMAT_VERSION, id: STEP_ID, description: "draft then judge" });
    expect((write.body["body"] as { id: string }[]).map((node) => node.id)).toEqual([NODE_IDS[1], NODE_IDS[0]]);
  });

  it("Save as template creates a new *.step-template.json with a fresh id", async () => {
    const calls = renderApp();
    await editTemplate("draft-judge");

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as new template" });
    expect(within(dialog).getByText(".step-template.json")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "draft-judge-v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("draft-judge-v2.step-template.json"));
    const post = calls.templateWrites[0]!;
    expect(post).toMatchObject({ method: "POST", id: null, body: { kind: "step", name: "draft-judge-v2", description: "draft then judge" } });
    const created = post.body["body"] as { id: string; description: string };
    expect(created.id).not.toBe(STEP_ID);
    expect(created.description).toBe("draft then judge");
  });
});

describe("Save as… across template kinds", () => {
  it("saves a workflow-template as a step-template, keeping only the body and saying what it drops", async () => {
    const calls = renderApp();
    await editTemplate("nightly");

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as new template" });
    expect(within(dialog).getByLabelText("Workflow-template")).toBeChecked();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByLabelText("Step-template"));
    expect(within(dialog).getByRole("note")).toHaveTextContent("A step-template keeps only the body. input will be dropped.");
    expect(within(dialog).getByText(".step-template.json")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "nightly-core" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly-core.step-template.json"));
    const post = calls.templateWrites[0]!;
    expect(post.body).toMatchObject({ kind: "step", name: "nightly-core", description: "nightly blurb" });
    const created = post.body["body"] as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual(["body", "description", "format", "id"]);
    expect(created["id"]).not.toBe(USER_ID);
    expect((created["body"] as { id: string }[]).map((node) => node.id)).toEqual(NODE_IDS);
  });

  it("saves a step-template as a workflow-template, named by the new template", async () => {
    const calls = renderApp();
    await editTemplate("draft-judge");

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as new template" });
    expect(within(dialog).getByLabelText("Step-template")).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText("Workflow-template"));
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "draft-flow" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("draft-flow.workflow-template.json"));
    const post = calls.templateWrites[0]!;
    expect(post.body).toMatchObject({ kind: "workflow", name: "draft-flow" });
    const created = post.body["body"] as Record<string, unknown>;
    expect(created).toMatchObject({ format: FORMAT_VERSION, name: "draft-flow" });
    expect(created["id"]).not.toBe(STEP_ID);
    expect((created["body"] as { id: string }[]).map((node) => node.id)).toEqual(NODE_IDS);
  });
});
