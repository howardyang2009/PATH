import type { TemplateSummary, WorkflowSummary } from "@path/client-core";
import { makeCalls, type StubServerOptions, stubClient } from "@path/client-core/test-utils";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { fileMenuItem } from "./file-menu.js";

/** File > Upload…: one file from the user's computer into a folder of their own user root, then
 * opened. */

const WORKFLOW_ID = "44444444-5555-4555-8555-555555555555";
const OWN_PATH = "users/local/workflow/flow.workflow.json";
const WORKFLOW_FILE = {
  format: FORMAT_VERSION,
  id: WORKFLOW_ID,
  name: "flow",
  body: [
    { type: "prompt", id: "55555555-5555-4555-8555-555555555555", name: "alpha", prompt: "a" },
  ],
};

const TEMPLATE_ID = "11111111-5555-4555-8555-555555555555";
const OTHER = "99999999-5555-4555-8555-555555555555";
const NODES = [
  { id: "22222222-5555-4555-8555-555555555555", name: "draft", prompt: "a", type: "prompt" },
];
const TEMPLATE_SUMMARY: TemplateSummary = {
  id: TEMPLATE_ID,
  name: "gate",
  description: "blurb",
  kind: "step",
  origin: "user",
  read_only: false,
  valid: true,
  error: null,
};

function renderApp(options: Partial<StubServerOptions> = {}) {
  const calls = makeCalls();
  const client = stubClient({ calls, ...options });
  render(<App client={client} />);
  return { calls, client };
}

/** Pick `file` in File > Upload…'s file chooser. */
async function pick(file: File): Promise<void> {
  await screen.findByRole("radiogroup", { name: "Edit mode" });
  fireEvent.click(fileMenuItem("Upload…"));
  fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [file] } });
}

/** Upload `file` into `folder` of the user root, `""` for its top. */
async function upload(file: File, folder = ""): Promise<void> {
  await pick(file);
  await chooseFolder(folder);
}

async function chooseFolder(folder: string): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Upload to folder" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Folder" }), {
    target: { value: folder },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
}

const fileOf = (name: string, content: unknown): File =>
  new File([typeof content === "string" ? content : JSON.stringify(content)], name);

afterEach(() => vi.restoreAllMocks());

describe("Upload", () => {
  it("creates a new workflow in the user root and opens it", async () => {
    const { calls } = renderApp({ files: { [OWN_PATH]: JSON.stringify(WORKFLOW_FILE) } });

    await upload(fileOf("flow.workflow.json", WORKFLOW_FILE));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]).toEqual({
      body: { workflow_path: OWN_PATH, workflow: WORKFLOW_FILE },
      ifMatch: null,
    });
    const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
    await within(canvas).findByText("alpha");
  });

  it("creates a workflow in a typed new subfolder of the user root", async () => {
    const path = "users/local/workflow/lib/drafts/flow.workflow.json";
    const { calls } = renderApp({ files: { [path]: JSON.stringify(WORKFLOW_FILE) } });

    await pick(fileOf("flow.workflow.json", WORKFLOW_FILE));
    const dialog = await screen.findByRole("dialog", { name: "Upload to folder" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Folder" }), {
      target: { value: "/lib/drafts/" },
    });
    expect(within(dialog).getByTestId("upload-target")).toHaveTextContent(path);
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]?.body.workflow_path).toBe(path);
    await screen.findByText("alpha");
  });

  it("offers the user root's existing folders and refuses a dot-leading one", async () => {
    renderApp({
      workflows: { workflows: [ownRow("users/local/workflow/lib/drafts/x.workflow.json", OTHER)] },
    });

    await pick(fileOf("flow.workflow.json", WORKFLOW_FILE));
    const dialog = await screen.findByRole("dialog", { name: "Upload to folder" });
    const options = [...dialog.querySelectorAll("datalist option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["lib", "lib/drafts"]);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Folder" }), {
      target: { value: "lib/.hidden" },
    });
    expect(within(dialog).getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  it("asks before it replaces the own workflow of the same name and id", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = renderApp({
      files: { [OWN_PATH]: JSON.stringify(WORKFLOW_FILE) },
      workflows: { workflows: [ownRow(OWN_PATH, WORKFLOW_ID)] },
    });

    await upload(fileOf("flow.workflow.json", WORKFLOW_FILE));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace "flow.workflow.json"'));
    expect(calls.put[0]?.ifMatch).toBe('"stub"');
    expect(calls.release.map((call) => call.workflow_path)).toContain(OWN_PATH);
  });

  it("keeps this Designer's own lease when it replaces the workflow it has open", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls } = renderApp({
      files: { [OWN_PATH]: JSON.stringify(WORKFLOW_FILE) },
      workflows: { workflows: [ownRow(OWN_PATH, WORKFLOW_ID)] },
    });
    await upload(fileOf("flow.workflow.json", WORKFLOW_FILE));
    await screen.findByText("alpha");
    await waitFor(() => expect(calls.lock.length).toBeGreaterThan(1));
    const released = calls.release.length;

    fireEvent.change(screen.getByTestId("upload-input"), {
      target: { files: [fileOf("flow.workflow.json", WORKFLOW_FILE)] },
    });
    await chooseFolder("");

    await waitFor(() => expect(calls.put).toHaveLength(2));
    expect(calls.release).toHaveLength(released);
  });

  it("does not replace a workflow someone has open", async () => {
    const { calls } = renderApp({
      files: { [OWN_PATH]: JSON.stringify(WORKFLOW_FILE) },
      workflows: { workflows: [ownRow(OWN_PATH, WORKFLOW_ID)] },
      onLock: () =>
        new Response(JSON.stringify({ error: { message: "held" }, expires_at: null }), {
          status: 409,
        }),
    });

    await upload(fileOf("flow.workflow.json", WORKFLOW_FILE));

    const dialog = screen.getByRole("dialog", { name: "Upload to folder" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "being edited in another session",
    );
    expect(calls.put).toHaveLength(0);
  });

  it("uploads a workflow whose id another file holds as a copy with a fresh id", async () => {
    const copyPath = "users/local/workflow/mine.workflow.json";
    const { calls } = renderApp({
      files: { [copyPath]: JSON.stringify(WORKFLOW_FILE) },
      workflows: { workflows: [ownRow("shared/workflow/team.workflow.json", WORKFLOW_ID)] },
    });

    await upload(fileOf("flow.workflow.json", WORKFLOW_FILE));
    const dialog = await screen.findByRole("dialog", { name: "Upload as copy" });
    const name = within(dialog).getByRole("textbox");
    expect(name).toHaveValue("flow-copy");
    fireEvent.change(name, { target: { value: "mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    const written = calls.put[0]!.body;
    expect(written.workflow_path).toBe(copyPath);
    expect(written.workflow.id).not.toBe(WORKFLOW_ID);
    expect({ ...written.workflow, id: WORKFLOW_ID }).toEqual(WORKFLOW_FILE);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Upload as copy" })).toBeNull(),
    );
  });

  it("refuses a file whose content is not its kind, and writes nothing", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { calls } = renderApp();

    await pick(fileOf("gate.step-template.json", WORKFLOW_FILE));

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0]?.[0]).toContain("does not match its file type");
    expect(screen.queryByRole("dialog", { name: "Upload to folder" })).toBeNull();
    expect(calls.put).toHaveLength(0);
    expect(calls.templateWrites).toHaveLength(0);
  });

  it("creates a new template in the picked folder", async () => {
    const template = { format: FORMAT_VERSION, id: TEMPLATE_ID, description: "blurb", body: NODES };
    const { calls } = renderApp({
      templateBodies: {
        [TEMPLATE_ID]: { ...TEMPLATE_SUMMARY, format: FORMAT_VERSION, body: NODES, etag: '"t"' },
      },
    });

    await upload(fileOf("gate.step-template.json", template), "lib");

    await waitFor(() => expect(calls.templateWrites).toHaveLength(1));
    expect(calls.templateWrites[0]).toMatchObject({
      method: "POST",
      body: { kind: "step", name: "gate", folder: "lib", body: template },
    });
  });

  it("creates a new template and opens it in template mode", async () => {
    const template = { format: FORMAT_VERSION, id: TEMPLATE_ID, description: "blurb", body: NODES };
    const { calls } = renderApp({
      templateBodies: {
        [TEMPLATE_ID]: { ...TEMPLATE_SUMMARY, format: FORMAT_VERSION, body: NODES, etag: '"t"' },
      },
    });

    await upload(fileOf("gate.step-template.json", template));

    await waitFor(() => expect(calls.templateWrites).toHaveLength(1));
    expect(calls.templateWrites[0]).toMatchObject({
      method: "POST",
      body: { kind: "step", name: "gate", description: "blurb", body: template },
    });
    const canvas = await screen.findByRole("region", { name: "Workflow canvas" });
    await within(canvas).findByText("draft");
    expect(screen.getByRole("radio", { name: "Template" })).toBeChecked();
  });
});

function ownRow(relative_path: string, id: string): WorkflowSummary {
  return {
    relative_path,
    origin: relative_path.startsWith("users/") ? "user" : "shared",
    root_path: relative_path.split("/").pop() ?? "",
    action: "open",
    read_only: false,
    id,
    name: "flow",
    valid: true,
    is_root: true,
    error: null,
  };
}
