import { PathApiError, type TemplateSummary } from "@path/client-core";
import { makeCalls, stubClient } from "@path/client-core/test-utils";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { fileMenuItem, findFileMenuItem } from "./file-menu.js";

/** The Download button saves the active frame's saved file: a workflow by path, a template by id. */

const TEMPLATE_ID = "11111111-5555-4555-8555-555555555555";
const NODES = [
  { id: "22222222-5555-4555-8555-555555555555", name: "draft", prompt: "a", type: "prompt" },
  { id: "33333333-5555-4555-8555-555555555555", name: "judge", prompt: "b", type: "prompt" },
];
const TEMPLATE_SUMMARY: TemplateSummary = {
  id: TEMPLATE_ID,
  name: "nightly",
  description: "blurb",
  kind: "step",
  origin: "user",
  read_only: false,
  valid: true,
  error: null,
};
const WORKFLOW_PATH = "flows/main.workflow.json";
const WORKFLOW_FILE = {
  format: FORMAT_VERSION,
  id: "44444444-5555-4555-8555-555555555555",
  name: "flow",
  body: [
    { type: "prompt", id: "55555555-5555-4555-8555-555555555555", name: "alpha", prompt: "a" },
  ],
};

function renderApp(initialPath?: string) {
  const client = stubClient({
    files: { [WORKFLOW_PATH]: JSON.stringify(WORKFLOW_FILE) },
    templates: { templates: [TEMPLATE_SUMMARY] },
    templateBodies: {
      [TEMPLATE_ID]: { ...TEMPLATE_SUMMARY, format: FORMAT_VERSION, body: NODES, etag: '"t"' },
    },
    calls: makeCalls(),
  });
  const file = { fileName: "saved.json", blob: new Blob(["{}"]) };
  const downloadWorkflow = vi.spyOn(client, "downloadWorkflow").mockResolvedValue(file);
  const downloadTemplate = vi.spyOn(client, "downloadTemplate").mockResolvedValue(file);
  render(<App client={client} initialPath={initialPath} />);
  return { downloadWorkflow, downloadTemplate };
}

async function openTemplate(): Promise<HTMLElement> {
  const mode = await screen.findByRole("radiogroup", { name: "Edit mode" });
  fireEvent.click(within(mode).getByRole("radio", { name: "Template" }));
  const palette = screen.getByRole("region", { name: "Palette" });
  fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
  const panel = within(palette).getByRole("tabpanel", { name: "Templates" });
  fireEvent.doubleClick(await within(panel).findByRole("button", { name: /^nightly/ }));
  const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
  await within(canvas).findByText("draft");
  return canvas;
}

let saved: string[];
beforeEach(() => {
  saved = [];
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Download", () => {
  it("saves the open workflow by its path", async () => {
    const { downloadWorkflow } = renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");

    fireEvent.click(fileMenuItem("Download"));

    await waitFor(() => expect(saved).toEqual(["saved.json"]));
    expect(downloadWorkflow).toHaveBeenCalledWith(WORKFLOW_PATH);
  });

  it("is disabled on a new workflow that has no file yet", async () => {
    renderApp();
    await screen.findByRole("radiogroup", { name: "Edit mode" });

    const button = await findFileMenuItem("Download");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Save first");
  });

  it("saves the open template by its id in template author mode", async () => {
    const { downloadTemplate, downloadWorkflow } = renderApp();
    await openTemplate();

    fireEvent.click(fileMenuItem("Download"));

    await waitFor(() => expect(downloadTemplate).toHaveBeenCalledWith(TEMPLATE_ID));
    expect(downloadWorkflow).not.toHaveBeenCalled();
  });

  it("asks before it downloads the saved file of a dirty buffer, and stops on No", async () => {
    const { downloadTemplate } = renderApp();
    const canvas = await openTemplate();
    fireEvent.click(within(canvas).getByRole("button", { name: "Move draft down" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(fileMenuItem("Download"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Unsaved edits are not included"));
    expect(downloadTemplate).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(fileMenuItem("Download"));
    await waitFor(() => expect(downloadTemplate).toHaveBeenCalledTimes(1));
  });

  it("alerts with each ref the server could not follow", async () => {
    const { downloadWorkflow } = renderApp(WORKFLOW_PATH);
    await screen.findByText("alpha");
    downloadWorkflow.mockRejectedValue(
      new PathApiError(422, "workflow refs could not be bundled", [
        { ref: "gone.workflow.json", from: WORKFLOW_PATH, reason: "file not found" },
      ]),
    );
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});

    fireEvent.click(fileMenuItem("Download"));

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0]?.[0]).toContain(
      `gone.workflow.json (in ${WORKFLOW_PATH}): file not found`,
    );
  });
});
