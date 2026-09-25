import type { TemplateSummary } from "@path/client-core";
import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #578: insert a Step-Template into an open workflow. Selecting a step-template card fetches
 * `GET /v0/templates/:id` and arms its body; the canvas opens only the grammar-legal sockets for it, and
 * a place runs Instantiation (fresh ids, names uniquified on collision) and splices the nodes in — a
 * 2+-node body at a single-node slot wrapped in a fresh `sequence`. The inserted nodes are ordinary.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`;
}

const PATH = "flows/main.workflow.json";

function openFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a", publish: { z: "${output.a}" } },
      { type: "while-do", id: uuid(3), name: "loop", condition: { type: "exists", path: "context.z" }, max_iterations: 2, node: { type: "prompt", id: uuid(4), name: "body", prompt: "l" } },
      { type: "parallel", id: uuid(5), name: "fan", join: "collect", branches: [{ type: "prompt", id: uuid(6), name: "p1", prompt: "x" }] },
    ],
  };
}

function summary(name: string, overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return { id: `${name}-id`, name, description: `${name} blurb`, kind: "step", origin: "shipped", read_only: true, valid: true, error: null, ...overrides };
}

/** The template GUIDs the envelopes carry — they must never reach the workflow (no back-link). */
const TEMPLATE_NODE_IDS = [uuid(100), uuid(101), uuid(102)];

/** A two-node body whose first name collides with the file's `alpha`. */
const TWO_NODE_BODY = [
  { type: "prompt", id: TEMPLATE_NODE_IDS[0], name: "alpha", prompt: "draft it" },
  { type: "prompt", id: TEMPLATE_NODE_IDS[1], name: "judge", prompt: "judge it" },
];

function envelope(name: string, body: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${name}-id`,
    name,
    kind: "step",
    origin: "shipped",
    read_only: true,
    format: FORMAT_VERSION,
    description: `${name} blurb`,
    body,
    valid: true,
    error: null,
    etag: '"t"',
    ...overrides,
  };
}

const TEMPLATES = {
  templates: [summary("draft-judge"), summary("gate-check"), summary("nightly")],
};

const BODIES = {
  "draft-judge-id": envelope("draft-judge", TWO_NODE_BODY),
  "gate-check-id": envelope("gate-check", [{ type: "checkpoint", id: TEMPLATE_NODE_IDS[2], name: "gate", condition: { type: "exists", path: "context.z" } }]),
};

async function openApp(templateBodies: Record<string, unknown> = BODIES) {
  const calls = makeCalls();
  render(
    <App
      client={stubClient({ files: { [PATH]: JSON.stringify(openFile()) }, templates: TEMPLATES, templateBodies, calls })}
      initialPath={PATH}
    />,
  );
  await screen.findByText("alpha");
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  const palette = screen.getByRole("region", { name: "Palette" });
  fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
  return { calls, canvas, palette: within(palette).getByRole("tabpanel", { name: "Templates" }) };
}

async function armTemplate(palette: HTMLElement, name: string): Promise<HTMLElement> {
  const card = await within(palette).findByRole("button", { name: new RegExp(name) });
  fireEvent.click(card);
  await waitFor(() => expect(card).toHaveAttribute("aria-pressed", "true"));
  return card;
}

async function savedBody(calls: ReturnType<typeof makeCalls>): Promise<Record<string, unknown>[]> {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls.put).toHaveLength(1));
  return calls.put[0]!.body.workflow.body as Record<string, unknown>[];
}

describe("Insert a Step-Template into a workflow (#578)", () => {
  it("fetches the template on select and splices fresh nodes in at a list socket", async () => {
    const { calls, canvas, palette } = await openApp();
    await armTemplate(palette, "draft-judge");

    fireEvent.click(within(canvas).getByRole("button", { name: /add draft-judge here/ }));

    const body = await savedBody(calls);
    expect(body.map((node) => node["name"])).toEqual(["alpha", "loop", "fan", "alpha-2", "judge"]);
    const inserted = body.slice(3);
    expect(inserted.map((node) => node["prompt"])).toEqual(["draft it", "judge it"]);
    // Fresh ids, and nothing in the file points back at the template.
    const saved = JSON.stringify(calls.put[0]!.body.workflow);
    for (const id of [...TEMPLATE_NODE_IDS, "draft-judge-id"]) expect(saved).not.toContain(id);
    expect(new Set(inserted.map((node) => node["id"])).size).toBe(2);
  });

  it("wraps a 2+-node body in a fresh sequence at a single-node slot", async () => {
    const { calls, canvas, palette } = await openApp();
    await armTemplate(palette, "draft-judge");

    fireEvent.click(within(canvas).getByRole("button", { name: /swap for draft-judge/ }));

    const body = await savedBody(calls);
    const loop = body.find((node) => node["name"] === "loop")!;
    const occupant = loop["node"] as { type: string; body: { name: string }[] };
    expect(occupant.type).toBe("sequence");
    expect(occupant.body.map((node) => node.name)).toEqual(["alpha-2", "judge"]);
  });

  it("adds a 2+-node body as one parallel branch, wrapped in a sequence, so it still runs in order", async () => {
    const { calls, canvas, palette } = await openApp();
    await armTemplate(palette, "draft-judge");

    fireEvent.click(within(canvas).getByRole("button", { name: /add draft-judge branch/ }));

    const body = await savedBody(calls);
    const fan = body.find((node) => node["name"] === "fan")!;
    const branches = fan["branches"] as { type: string; name: string; body?: { name: string }[] }[];
    expect(branches.map((branch) => branch.type)).toEqual(["prompt", "sequence"]);
    expect(branches[1]!.body!.map((node) => node.name)).toEqual(["alpha-2", "judge"]);
  });

  it("refuses a grammar-illegal drop target: a lone checkpoint opens no single-slot socket", async () => {
    const { canvas, palette } = await openApp();
    await armTemplate(palette, "gate-check");

    expect(within(canvas).getByRole("button", { name: /add gate-check here/ })).toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /swap for gate-check/ })).not.toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /add gate-check branch/ })).not.toBeInTheDocument();
  });

  it("inserts ordinary nodes the pane edits like any other", async () => {
    const { calls, canvas, palette } = await openApp();
    await armTemplate(palette, "draft-judge");
    fireEvent.click(within(canvas).getByRole("button", { name: /add draft-judge here/ }));

    fireEvent.click(within(canvas).getByText("judge").closest(".node-block") as HTMLElement);
    const pane = screen.getByRole("region", { name: "Properties" });
    fireEvent.change(within(pane).getByLabelText("prompt"), { target: { value: "judge it harder" } });

    const body = await savedBody(calls);
    expect(body.find((node) => node["name"] === "judge")!["prompt"]).toBe("judge it harder");
  });

  it("disarms after a place and on a second click of the armed card", async () => {
    const { canvas, palette } = await openApp();
    const card = await armTemplate(palette, "draft-judge");
    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(within(canvas).queryByRole("button", { name: /add draft-judge here/ })).not.toBeInTheDocument();

    await armTemplate(palette, "draft-judge");
    fireEvent.click(within(canvas).getByRole("button", { name: /add draft-judge here/ }));
    expect(card).toHaveAttribute("aria-pressed", "false");
  });

  it("does not arm a template the server reports invalid, and says why", async () => {
    const { canvas, palette } = await openApp({
      "draft-judge-id": envelope("draft-judge", TWO_NODE_BODY, { valid: false, error: { message: 'unregistered step type "api-call"' } }),
    });
    const card = await within(palette).findByRole("button", { name: /draft-judge/ });
    fireEvent.click(card);

    expect(await within(palette).findByRole("alert")).toHaveTextContent('unregistered step type "api-call"');
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(within(canvas).queryByRole("button", { name: /draft-judge/ })).not.toBeInTheDocument();
  });

  it("a template select disarms what was armed before, so a failed read leaves nothing armed", async () => {
    const { canvas } = await openApp({});
    const tabs = screen.getByRole("region", { name: "Palette" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "Build" }));
    fireEvent.click(screen.getByText("Prompt"));
    expect(within(canvas).getByRole("button", { name: /add prompt here/ })).toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole("tab", { name: "Templates" }));
    const panel = within(tabs).getByRole("tabpanel", { name: "Templates" });
    fireEvent.click(await within(panel).findByRole("button", { name: /draft-judge/ }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(/draft-judge/);
    expect(within(canvas).queryByRole("button", { name: /add prompt here/ })).not.toBeInTheDocument();
  });

  it("reports a failed template read", async () => {
    const { palette } = await openApp({});
    fireEvent.click(await within(palette).findByRole("button", { name: /draft-judge/ }));

    expect(await within(palette).findByRole("alert")).toHaveTextContent(/draft-judge/);
  });
});
