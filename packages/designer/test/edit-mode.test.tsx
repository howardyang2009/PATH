import type { TemplateSummary } from "@path/client-core";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * The toolbar's Workflow | Template edit-mode switch. Workflow mode edits `*.workflow.json` files;
 * template mode edits template sources. New and Open… act in the current mode, a switch clears the
 * canvas, and every door that replaces the stack asks before discarding unsaved edits.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-6666-4666-8666-666666666666`;
}

const TEMPLATE_ID = uuid(1);
const SUMMARY: TemplateSummary = {
  id: TEMPLATE_ID,
  name: "nightly",
  description: "nightly blurb",
  kind: "workflow",
  origin: "user",
  read_only: false,
  valid: true,
  error: null,
};
const ENVELOPE = {
  ...SUMMARY,
  format: FORMAT_VERSION,
  body: {
    format: FORMAT_VERSION,
    id: TEMPLATE_ID,
    name: "nightly",
    body: [{ type: "prompt", id: uuid(2), name: "draft", prompt: "draft it" }],
  },
  etag: '"t"',
};

const WORKFLOW_PATH = "flows/main.workflow.json";
const WORKFLOW_FILE = {
  format: FORMAT_VERSION,
  id: uuid(20),
  name: "main",
  body: [{ type: "prompt", id: uuid(21), name: "alpha", prompt: "a" }],
};

function renderApp(initialPath?: string) {
  const calls = makeCalls();
  render(
    <App
      client={stubClient({
        files: { [WORKFLOW_PATH]: JSON.stringify(WORKFLOW_FILE) },
        templates: { templates: [SUMMARY] },
        templateBodies: { [TEMPLATE_ID]: ENVELOPE },
        calls,
      })}
      initialPath={initialPath}
    />,
  );
  return calls;
}

function modeSwitch(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Edit mode" });
}

async function switchTo(label: "Workflow" | "Template"): Promise<void> {
  await screen.findByRole("radiogroup", { name: "Edit mode" });
  fireEvent.click(within(modeSwitch()).getByRole("radio", { name: label }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Delete", () => {
  it("deletes the open workflow after a confirm, under its If-Match, and empties the canvas", async () => {
    const calls = renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(`Delete "${WORKFLOW_PATH}"?`));
    await waitFor(() => expect(calls.deletes).toHaveLength(1));
    expect(calls.deletes[0]!.url).toMatch(/^\/v0\/workflows\/file\?path=flows%2Fmain\.workflow\.json&session_id=/);
    expect(calls.deletes[0]!.ifMatch).toBe('"stub"');
    expect((await screen.findByText("Deleted")).closest(".topbar-title")).not.toBeNull();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("keeps the file when the confirm is cancelled", async () => {
    const calls = renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");
    vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(calls.deletes).toHaveLength(0);
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("shows a refused delete in the top bar and keeps the file open", async () => {
    const calls = makeCalls();
    render(
      <App
        client={stubClient({
          files: { [WORKFLOW_PATH]: JSON.stringify(WORKFLOW_FILE) },
          calls,
          onDelete: () => new Response(JSON.stringify({ error: { message: "workflow is being edited in another session" } }), { status: 409 }),
        })}
        initialPath={WORKFLOW_PATH}
      />,
    );
    await screen.findByText("alpha");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByText(/Could not delete: workflow is being edited in another session/);
    expect(alert.closest(".topbar-title")).not.toBeNull();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("deletes the open user template by id", async () => {
    const calls = renderApp();
    await switchTo("Template");
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    fireEvent.click(await screen.findByRole("button", { name: /nightly/ }));
    await screen.findByText("draft");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete template "nightly"?'));
    await waitFor(() => expect(calls.deletes).toHaveLength(1));
    expect(calls.deletes[0]!.url).toBe(`/v0/templates/${TEMPLATE_ID}`);
    expect(await screen.findByText("Deleted")).toBeInTheDocument();
  });

  it("disables Delete for a new, never-saved workflow", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});

describe("Workflow | Template edit-mode switch", () => {
  it("starts in workflow mode and switches to an empty template canvas", async () => {
    renderApp();
    await screen.findByRole("button", { name: "New workflow" });
    expect(within(modeSwitch()).getByRole("radio", { name: "Workflow" })).toHaveAttribute("aria-checked", "true");

    await switchTo("Template");
    expect(within(modeSwitch()).getByRole("radio", { name: "Template" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "New template" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open template" })).toBeInTheDocument();
  });

  it("New in template mode starts an empty template; its first Save picks kind and name", async () => {
    const calls = renderApp();
    await switchTo("Template");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    expect(screen.getByText("New template (not saved)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save new template" });
    fireEvent.click(within(dialog).getByLabelText("Workflow-template"));
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "weekly" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("weekly.workflow-template.json"));
    expect(calls.templateWrites[0]).toMatchObject({ method: "POST", id: null, body: { kind: "workflow", name: "weekly" } });
    expect((calls.templateWrites[0]!.body["body"] as { name: string }).name).toBe("weekly");
  });

  it("a new step-template needs a description before it can be created", async () => {
    const calls = renderApp();
    await switchTo("Template");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(await screen.findByRole("button", { name: "Save as…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Save new template" });
    expect(within(dialog).getByLabelText("Step-template")).toBeChecked();
    expect(within(dialog).getByLabelText("Template description").tagName).toBe("TEXTAREA");
    fireEvent.change(within(dialog).getByLabelText("Template name"), { target: { value: "gate" } });
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Template description"), { target: { value: "a gate" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls.templateWrites).toHaveLength(1));
    expect(calls.templateWrites[0]!.body).toMatchObject({ kind: "step", name: "gate", description: "a gate" });
    expect(Object.keys(calls.templateWrites[0]!.body["body"] as object).sort()).toEqual(["body", "description", "format", "id"]);
  });

  it("Open… in template mode lists templates and opens the chosen one", async () => {
    renderApp();
    await switchTo("Template");
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));

    const dialog = await screen.findByRole("dialog", { name: "Open a template" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /nightly\.workflow-template\.json/ }));

    await screen.findByText("draft");
    expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly.workflow-template.json");
  });

  it("a template double-click edits only in template mode", async () => {
    renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");
    const palette = screen.getByRole("region", { name: "Palette" });
    fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
    const card = await within(palette).findByRole("button", { name: /^nightly/ });
    expect(card).toHaveAttribute("title", expect.stringContaining("Switch to Template mode to edit this template."));

    // In workflow mode the double-click leaves the open workflow alone.
    fireEvent.doubleClick(card);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(within(modeSwitch()).getByRole("radio", { name: "Workflow" })).toHaveAttribute("aria-checked", "true");

    await switchTo("Template");
    fireEvent.doubleClick(await within(palette).findByRole("button", { name: /^nightly/ }));
    await screen.findByText("draft");
    expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly.workflow-template.json");
  });

  it("switches away from an untouched New workflow or template without asking", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(within(modeSwitch()).getByRole("radio", { name: "Template" }));
    expect(within(modeSwitch()).getByRole("radio", { name: "Template" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    fireEvent.click(within(modeSwitch()).getByRole("radio", { name: "Workflow" }));
    expect(within(modeSwitch()).getByRole("radio", { name: "Workflow" })).toHaveAttribute("aria-checked", "true");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows \"Unsaved edits\" in the top bar only once a New workflow is edited", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    expect(screen.queryByText("Unsaved edits")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Prompt"));
    fireEvent.click(within(screen.getByRole("region", { name: "Workflow canvas" })).getByRole("button", { name: /add prompt here/ }));
    expect(screen.getByText("Unsaved edits").closest(".topbar-title")).not.toBeNull();
  });

  it("asks before a switch discards unsaved edits, and keeps them on cancel", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    fireEvent.click(screen.getByText("Prompt"));
    fireEvent.click(within(screen.getByRole("region", { name: "Workflow canvas" })).getByRole("button", { name: /add prompt here/ }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(within(modeSwitch()).getByRole("radio", { name: "Template" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(within(modeSwitch()).getByRole("radio", { name: "Workflow" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeInTheDocument();
  });

  it("disables Save as… for a new, never-saved workflow: its first save is Save", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByRole("region", { name: "Workflow canvas" });
    expect(screen.getByRole("button", { name: "Save as…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("Save as… in workflow mode writes a copy to a new file, then edits the copy", async () => {
    const calls = renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");

    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save workflow as" });
    expect(within(dialog).getByLabelText("Filename")).toHaveValue("main-copy");
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "other" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    const { workflow_path, workflow } = calls.put[0]!.body;
    // An exclusive create in the source file's directory; the copy is a new workflow with its new name.
    expect(calls.put[0]!.ifMatch).toBeNull();
    expect(workflow_path).toBe("flows/other.workflow.json");
    expect(workflow["name"]).toBe("other");
    expect(workflow["id"]).not.toBe(WORKFLOW_FILE.id);
    expect(JSON.stringify(workflow)).not.toContain(uuid(21));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("disables the Runs dock in template mode, since a template never runs", async () => {
    renderApp();
    const toggle = await screen.findByTestId("run-dock-toggle");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await switchTo("Template");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Templates do not run/)).toBeInTheDocument();

    await switchTo("Workflow");
    expect(toggle).toBeEnabled();
  });

  it("a real double-click on a Workflow-Template in template mode opens it, placing nothing first", async () => {
    renderApp();
    await switchTo("Template");
    const palette = screen.getByRole("region", { name: "Palette" });
    fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
    const card = await within(palette).findByRole("button", { name: /^nightly/ });
    const confirm = vi.spyOn(window, "confirm");

    // A browser double-click fires two clicks, then the dblclick. Let the first click's read land.
    fireEvent.click(card);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.click(card);
    fireEvent.doubleClick(card);

    await waitFor(() => expect(screen.getByTestId("author-mode")).toHaveTextContent("nightly.workflow-template.json"));
    expect(confirm).not.toHaveBeenCalled();
  });
});
