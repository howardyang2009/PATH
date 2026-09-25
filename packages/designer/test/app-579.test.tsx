import type { TemplateSummary } from "@path/client-core";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #579: start a workflow from a Workflow-Template. The card is selectable only into an empty canvas
 * (nothing open, or a buffer with zero nodes). Selecting it reads `GET /v0/templates/:id` and runs
 * Instantiation plus a workflow-level re-mint (ADR 0049 decision 7): a fresh workflow id and fresh node
 * ids, `input` and `worker_defaults` verbatim. The instance is an unsaved buffer whose Save is the
 * first-save dialog's `*.workflow.json` create through `PUT /v0/workflows` (consume mode), never the
 * template.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;
}

const TEMPLATE_ID = uuid(1);
const TEMPLATE_NODE_IDS = [uuid(2), uuid(3)];

/** The whole workflow file a workflow-template envelope carries as its `body`. */
function templateWorkflow(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: TEMPLATE_ID,
    name: "nightly",
    input: { ticket: "PATH-1" },
    worker_defaults: { prompt: "claude" },
    body: [
      { type: "prompt", id: TEMPLATE_NODE_IDS[0], name: "draft", prompt: "draft it" },
      { type: "prompt", id: TEMPLATE_NODE_IDS[1], name: "judge", prompt: "judge it" },
    ],
  };
}

function summary(overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return { id: TEMPLATE_ID, name: "nightly", description: "nightly blurb", kind: "workflow", origin: "shipped", read_only: true, valid: true, error: null, ...overrides };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE_ID,
    name: "nightly",
    kind: "workflow",
    origin: "shipped",
    read_only: true,
    format: FORMAT_VERSION,
    description: "nightly blurb",
    body: templateWorkflow(),
    valid: true,
    error: null,
    etag: '"t"',
    ...overrides,
  };
}

const PATH = "flows/main.workflow.json";
const OPEN_FILE = {
  format: FORMAT_VERSION,
  id: uuid(20),
  name: "flow",
  body: [{ type: "prompt", id: uuid(21), name: "alpha", prompt: "a" }],
};

function renderApp(options: { initialPath?: string; body?: Record<string, unknown> } = {}) {
  const calls = makeCalls();
  render(
    <App
      client={stubClient({
        files: { [PATH]: JSON.stringify(OPEN_FILE) },
        templates: { templates: [summary()] },
        templateBodies: { [TEMPLATE_ID]: options.body ?? envelope() },
        calls,
      })}
      initialPath={options.initialPath}
    />,
  );
  return calls;
}

function templatesPanel(): HTMLElement {
  const palette = screen.getByRole("region", { name: "Palette" });
  fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
  return within(palette).getByRole("tabpanel", { name: "Templates" });
}

async function workflowTemplateCard(): Promise<HTMLElement> {
  return within(templatesPanel()).findByRole("button", { name: /^nightly/ });
}

describe("Instantiate a Workflow-Template into an empty canvas (#579)", () => {
  it("instantiates into an empty canvas and saves the instance as a *.workflow.json", async () => {
    const calls = renderApp();
    await screen.findByRole("button", { name: "New workflow" });

    const card = await workflowTemplateCard();
    expect(card).toBeEnabled();
    fireEvent.click(card);

    const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
    await within(canvas).findByText("draft");
    expect(within(canvas).getByText("judge")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    expect(within(dialog).getByLabelText("Filename")).toHaveValue("nightly");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    const { workflow_path, workflow } = calls.put[0]!.body;
    expect(workflow_path).toBe("nightly.workflow.json");
    expect(workflow["id"]).not.toBe(TEMPLATE_ID);
    expect(workflow["input"]).toEqual({ ticket: "PATH-1" });
    expect(workflow["worker_defaults"]).toEqual({ prompt: "claude" });
    const body = workflow["body"] as Record<string, unknown>[];
    expect(body.map((node) => node["name"])).toEqual(["draft", "judge"]);
    const saved = JSON.stringify(workflow);
    for (const id of TEMPLATE_NODE_IDS) expect(saved).not.toContain(id);
  });

  it("instantiates into an empty from-scratch buffer", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await screen.findByRole("region", { name: "Start a body" });

    fireEvent.click(await workflowTemplateCard());

    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    await within(canvas).findByText("draft");
  });

  it("is not selectable while the canvas holds nodes", async () => {
    renderApp({ initialPath: PATH });
    await screen.findByText("alpha");
    expect(await workflowTemplateCard()).toHaveAttribute("aria-disabled", "true");
  });

  it("disables the card once the instance fills the canvas", async () => {
    renderApp();
    await screen.findByRole("button", { name: "New workflow" });
    fireEvent.click(await workflowTemplateCard());
    await screen.findByText("draft");

    expect(await workflowTemplateCard()).toHaveAttribute("aria-disabled", "true");
  });

  it("puts nothing on the canvas for a template the server reports invalid, and says why", async () => {
    renderApp({ body: envelope({ valid: false, error: { message: 'unregistered step type "api-call"' } }) });
    await screen.findByRole("button", { name: "New workflow" });
    fireEvent.click(await workflowTemplateCard());

    expect(await within(templatesPanel()).findByRole("alert")).toHaveTextContent('unregistered step type "api-call"');
    expect(screen.queryByRole("region", { name: "Workflow canvas" })).not.toBeInTheDocument();
  });
});
