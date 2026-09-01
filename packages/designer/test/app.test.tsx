import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed, so fixtures read as ids without a random source. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ROOT_PATH = "flows/main.workflow.json";
const CHILD_PATH = "flows/sub/child.workflow.json";

/** A whole valid `@3` root file exercising every block shape, plus a `workflow` ref to a child file. */
function rootFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "root-flow",
    body: [
      { type: "prompt", id: uuid(2), name: "draft", prompt: "hi" },
      {
        type: "parallel",
        id: uuid(3),
        name: "fan",
        join: "collect",
        branches: [
          { type: "binary", id: uuid(4), name: "build", command: "make" },
          { type: "prompt", id: uuid(5), name: "review", prompt: "check" },
        ],
      },
      {
        type: "branch",
        id: uuid(6),
        name: "gate",
        arms: [{ when: { type: "exists", path: "context.x" }, node: { type: "prompt", id: uuid(7), name: "arm-a", prompt: "a" } }],
        else: { type: "prompt", id: uuid(8), name: "fallback", prompt: "f" },
      },
      {
        type: "while-do",
        id: uuid(9),
        name: "loop",
        condition: { type: "exists", path: "context.y" },
        max_iterations: 3,
        node: {
          type: "sequence",
          id: uuid(10),
          name: "seq",
          body: [{ type: "checkpoint", id: uuid(11), name: "chk", condition: { type: "exists", path: "output.z" } }],
        },
      },
      { type: "workflow", id: uuid(12), name: "sub", ref: "sub/child.workflow.json" },
    ],
  };
}

function childFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(40),
    name: "child-flow",
    body: [{ type: "prompt", id: uuid(41), name: "child-step", prompt: "deep" }],
  };
}

function filesWith(root: unknown): Record<string, string> {
  return { [ROOT_PATH]: JSON.stringify(root), [CHILD_PATH]: JSON.stringify(childFile()) };
}

describe("Designer shell (#366 tracer bullet, still true)", () => {
  it("renders the authoring shell, not the read-only Viewer", () => {
    render(<App client={stubClient()} />);
    expect(screen.getByText("PATH")).toBeInTheDocument();
    expect(screen.getByText("designer · authoring")).toBeInTheDocument();
  });

  it("shows the palette shell split into registry-driven Steps and grammar-fixed Blocks", async () => {
    render(<App client={stubClient()} />);
    const palette = screen.getByRole("region", { name: "Palette" });
    const steps = within(palette).getByRole("region", { name: "Steps" });
    // Steps are registry-driven (#368): the stub ships `binary` + `prompt`, and `workflow` is always
    // offered as a leaf-step entry. They land once `GET /v0/step-plugins` resolves.
    expect(await within(steps).findByText("Prompt")).toBeInTheDocument();
    for (const label of ["Binary", "Workflow"]) {
      expect(within(steps).getByText(label)).toBeInTheDocument();
    }
    const blocks = within(palette).getByRole("region", { name: "Blocks" });
    for (const label of ["Parallel", "Branch", "While-do", "Sequence", "Checkpoint"]) {
      expect(within(blocks).getByText(label)).toBeInTheDocument();
    }
  });

  it("shows an empty canvas when no file is opened", async () => {
    render(<App client={stubClient()} />);
    expect(await screen.findByText("Empty canvas")).toBeInTheDocument();
  });
});

describe("Designer open + render (#367)", () => {
  it("opens a valid @3 file and renders it in the block grammar", async () => {
    render(<App client={stubClient({ files: filesWith(rootFile()) })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    // Leaf chips: LLM for a prompt, COMMAND for a binary.
    expect(within(canvas).getAllByText("LLM").length).toBeGreaterThan(0);
    expect(within(canvas).getByText("COMMAND")).toBeInTheDocument();
    // Node names across nested blocks. A parallel branch's name shows twice — once as the block's own
    // name, once as the branch caption (spec: each branch is captioned by its own node name) — so match
    // one-or-more rather than exactly one.
    for (const name of ["draft", "fan", "build", "review", "gate", "arm-a", "fallback", "loop", "seq", "chk", "sub"]) {
      expect(within(canvas).getAllByText(name).length).toBeGreaterThan(0);
    }
    // Read-only summaries.
    expect(within(canvas).getByText("join: collect")).toBeInTheDocument();
    expect(within(canvas).getByText("when exists context.x")).toBeInTheDocument();
    expect(within(canvas).getByText("while exists context.y · max 3")).toBeInTheDocument();
    expect(within(canvas).getByText("assert exists output.z")).toBeInTheDocument();
    // The ref chip shows its target path.
    expect(within(canvas).getByText("sub/child.workflow.json")).toBeInTheDocument();
  });

  it("descends across a workflow-ref on double-click and tracks the crossing in the breadcrumb", async () => {
    render(<App client={stubClient({ files: filesWith(rootFile()) })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    const refChip = screen.getByText("sub/child.workflow.json").closest('[role="button"]')!;
    fireEvent.doubleClick(refChip);

    // The ref'd file's body is now on the canvas.
    expect(await screen.findByText("child-step")).toBeInTheDocument();
    // The breadcrumb tracks the crossing: root file, then child file (current).
    const crumbs = screen.getByRole("navigation", { name: "File breadcrumb" });
    expect(within(crumbs).getByText("root-flow")).toBeInTheDocument();
    expect(within(crumbs).getByText("child-flow")).toBeInTheDocument();

    // Clicking the root crumb pops the stack back.
    fireEvent.click(within(crumbs).getByRole("button", { name: "root-flow" }));
    expect(await screen.findByText("draft")).toBeInTheDocument();
  });

  it("refuses a file naming an unregistered step type, with the aggregate recoverable error", async () => {
    const file = rootFile();
    (file.body as unknown[]).push({ type: "api-call", id: uuid(50), name: "call-a", endpoint: "x" });
    render(<App client={stubClient({ files: filesWith(file) })} initialPath={ROOT_PATH} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("packages/engine/step-plugins/api-call/");
    expect(alert).toHaveTextContent("refresh the registry");
    // It refuses — no block tree.
    expect(screen.queryByText("draft")).not.toBeInTheDocument();
  });

  it("opens an id-less-but-valid file into a dirty buffer (ids stamped)", async () => {
    const file = rootFile();
    delete file.id;
    delete (file.body as Record<string, unknown>[])[0]!.id;
    render(<App client={stubClient({ files: filesWith(file) })} initialPath={ROOT_PATH} />);

    expect(await screen.findByText("draft")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("stamped on import");
  });

  it("refuses a file with a duplicate id", async () => {
    const file = rootFile();
    (file.body as Record<string, unknown>[])[1]!.id = uuid(2); // collide "fan" with "draft"
    render(<App client={stubClient({ files: filesWith(file) })} initialPath={ROOT_PATH} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Duplicate node ids");
    expect(screen.queryByText("draft")).not.toBeInTheDocument();
  });

  it("surfaces a 404 on the file as a legible read error", async () => {
    render(<App client={stubClient({ files: {} })} initialPath={ROOT_PATH} />);
    expect(await screen.findByText("Could not read the file")).toBeInTheDocument();
  });

  it("surfaces a registry failure rather than a broken canvas", async () => {
    render(<App client={stubClient({ pluginsStatus: 500, files: filesWith(rootFile()) })} initialPath={ROOT_PATH} />);
    expect(await screen.findByText("Registry unavailable")).toBeInTheDocument();
  });
});
