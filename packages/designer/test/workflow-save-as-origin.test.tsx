import { makeCalls, stubClient } from "@path/client-core/test-utils";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { fileMenuItem } from "./file-menu.js";

/**
 * Workflow Save as… picks mine or shared, as a template's Save as does: mine by default, the shared
 * pick confines the directory to the shared workflow root, and the Server stamps the creator.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-6666-4666-8666-666666666666`;
}

const MINE_PATH = "users/local/workflow/main.workflow.json";
const SHARED_PATH = "shared/workflow/team/main.workflow.json";
const FILE = {
  format: FORMAT_VERSION,
  id: uuid(20),
  name: "main",
  body: [{ type: "prompt", id: uuid(21), name: "alpha", prompt: "a" }],
};

function summary(relative_path: string, origin: "user" | "shared") {
  return {
    relative_path,
    origin,
    root_path: relative_path,
    action: "open",
    id: FILE.id,
    name: FILE.name,
    valid: true,
    is_root: true,
    read_only: false,
    error: null,
  };
}

function renderApp(
  initialPath: string,
  onPut?: NonNullable<Parameters<typeof stubClient>[0]>["onPut"],
) {
  const calls = makeCalls();
  render(
    <App
      client={stubClient({
        files: { [MINE_PATH]: JSON.stringify(FILE), [SHARED_PATH]: JSON.stringify(FILE) },
        workflows: {
          workflows: [summary(MINE_PATH, "user"), summary(SHARED_PATH, "shared")],
        },
        calls,
        ...(onPut ? { onPut } : {}),
      })}
      initialPath={initialPath}
    />,
  );
  return calls;
}

async function openSaveAs(): Promise<HTMLElement> {
  await screen.findByText("alpha");
  fireEvent.click(fileMenuItem("Save as…"));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Save as" })).getByRole("button", {
      name: /Workflow…/,
    }),
  );
  return screen.findByRole("dialog", { name: "Save workflow as" });
}

function optionNames(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("workflow Save as… mine / shared picker", () => {
  it("defaults to mine, even for a shared source, and offers only mine's directories", async () => {
    renderApp(SHARED_PATH);
    const dialog = await openSaveAs();

    const saveTo = within(dialog).getByLabelText<HTMLSelectElement>("Save to");
    expect(saveTo.value).toBe("user");
    expect(optionNames(saveTo)).toEqual(["Mine", "Shared"]);
    const directory = within(dialog).getByLabelText<HTMLSelectElement>("Directory");
    await waitFor(() => expect(directory.value).toBe("users/local/workflow"));
    expect(optionNames(directory)).toEqual(["users/local/workflow"]);
  });

  it("keeps a mine source's directory preselected", async () => {
    renderApp(MINE_PATH);
    const dialog = await openSaveAs();
    expect(within(dialog).getByLabelText<HTMLSelectElement>("Directory").value).toBe(
      "users/local/workflow",
    );
  });

  it("saves to shared under shared/workflow/ as an exclusive create", async () => {
    const calls = renderApp(MINE_PATH);
    const dialog = await openSaveAs();

    fireEvent.change(within(dialog).getByLabelText("Save to"), { target: { value: "shared" } });
    const directory = within(dialog).getByLabelText<HTMLSelectElement>("Directory");
    expect(directory.value).toBe("shared/workflow");
    expect(optionNames(directory)).toEqual(["shared/workflow", "shared/workflow/team"]);
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "copy" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]!.ifMatch).toBeNull();
    expect(calls.put[0]!.body.workflow_path).toBe("shared/workflow/copy.workflow.json");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the Server's refusal of a shared save in the dialog", async () => {
    renderApp(
      MINE_PATH,
      () =>
        new Response(
          JSON.stringify({
            error: { message: "workflow validation failed", details: ["duplicate id"] },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const dialog = await openSaveAs();
    fireEvent.change(within(dialog).getByLabelText("Save to"), { target: { value: "shared" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "workflow validation failed",
    );
    expect(screen.getByRole("dialog", { name: "Save workflow as" })).toBeInTheDocument();
  });
});
