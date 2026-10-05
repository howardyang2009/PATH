import { stubClient } from "@path/client-core/test-utils";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { fileMenuItem } from "./file-menu.js";

/**
 * A shared workflow another user created is read-only for this requester (ADR 0088): discovery marks
 * it `read_only`, the Open dialog shows a lock, and the Designer disables Save and Delete while it
 * still offers Save as. A write the Server refuses late reads as the spec's messages.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const THEIRS = "shared/workflow/theirs.workflow.json";
const OURS = "shared/workflow/ours.workflow.json";

/** An id-less file: it opens dirty, so Save would be enabled were the file writable. */
function idlessFile(stepName: string): string {
  return JSON.stringify({
    format: FORMAT_VERSION,
    name: "flow",
    body: [{ type: "prompt", id: uuid(2), name: stepName, prompt: "hi" }],
  });
}

function row(path: string, readOnly: boolean): Record<string, unknown> {
  return {
    relative_path: path,
    origin: "shared",
    root_path: path.replace("shared/workflow/", ""),
    action: "open",
    read_only: readOnly,
    id: null,
    name: null,
    valid: true,
    is_root: true,
    error: null,
  };
}

const WORKFLOWS = { workflows: [row(THEIRS, true), row(OURS, false)] };
const FILES = { [THEIRS]: idlessFile("their-step"), [OURS]: idlessFile("our-step") };

function refuse(status: number, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("read-only shared workflows", () => {
  it("shows a lock and read-only on the Open dialog's read-only row only", async () => {
    render(<App client={stubClient({ files: FILES, workflows: WORKFLOWS })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open workflow" }));
    const dialog = await screen.findByRole("dialog", { name: "Open a workflow" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /shared/ }));

    expect(
      within(dialog).getByRole("button", { name: /theirs\.workflow\.json/ }),
    ).toHaveTextContent("🔒read-only");
    expect(
      within(dialog).getByRole("button", { name: /ours\.workflow\.json/ }),
    ).not.toHaveTextContent("read-only");
  });

  it("disables Save and Delete on a read-only file and offers Save as", async () => {
    render(
      <App client={stubClient({ files: FILES, workflows: WORKFLOWS })} initialPath={THEIRS} />,
    );

    await screen.findByText("their-step");
    const save = await screen.findByRole("button", { name: "Save" });
    // Discovery lands after the file opens; the read-only verdict is its row's.
    await waitFor(() => expect(save).toHaveAttribute("title", "Read-only: shared by another user"));
    expect(save).toBeDisabled();
    expect(fileMenuItem("Delete")).toBeDisabled();
    expect(fileMenuItem("Delete")).toHaveAttribute("title", "Read-only: shared by another user");
    expect(fileMenuItem("Save as…")).toBeEnabled();
  });

  it("reads a late 403 on save as read-only, pointing to Save as", async () => {
    const onPut = refuse(403, "only the creator edits a shared item");
    render(
      <App client={stubClient({ files: FILES, workflows: WORKFLOWS, onPut })} initialPath={OURS} />,
    );

    await screen.findByText("our-step");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/Read-only: only the creator can save\. Use Save as\./),
    ).toBeInTheDocument();
  });

  it("reads a late 404 on save as no longer available", async () => {
    const onPut = refuse(404, "not found");
    render(
      <App client={stubClient({ files: FILES, workflows: WORKFLOWS, onPut })} initialPath={OURS} />,
    );

    await screen.findByText("our-step");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/No longer available/)).toBeInTheDocument();
  });
});
