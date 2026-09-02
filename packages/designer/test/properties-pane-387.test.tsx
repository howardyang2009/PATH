import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, stubClient } from "./stub-server.js";

/**
 * The `$env` / `$secret` authoring affordance on a config value (#387, designer-spec § `$env` / `$secret`
 * authoring, map decision 9). A per-config-value mode selector (`Literal` / `$env` / `$secret`) edits the
 * config region only; display is reference-only (never a resolved value); the wrapper round-trips intact.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/** A step overriding a plain config key `region`, so the pane opens it in Literal mode. */
function paneFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [{ type: "prompt", id: uuid(2), name: "alpha", prompt: "a", config: { region: "us" } }],
  };
}

async function openPane(seed: Record<string, unknown> = paneFile()) {
  render(<App client={stubClient({ files: { [PATH]: JSON.stringify(seed) } })} initialPath={PATH} />);
  await screen.findByText("alpha");
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  const pane = screen.getByRole("region", { name: "Properties" });
  return { canvas, pane };
}

function selectNode(canvas: HTMLElement, name: string): void {
  const matches = within(canvas).getAllByText(name);
  const nameSpan = matches.find((el) => el.classList.contains("node-name")) ?? matches[0]!;
  fireEvent.click(nameSpan.closest(".node-block") as HTMLElement);
}

describe("#387 config value mode selector", () => {
  it("opens a literal config value in Literal mode with its scalar input", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).getByLabelText("region mode")).toHaveValue("literal");
    expect(within(pane).getByLabelText("region")).toHaveValue("us");
  });

  it("wraps a value as $env and shows a reference-only chip, never a resolved value", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    fireEvent.change(within(pane).getByLabelText("region mode"), { target: { value: "env" } });
    const name = within(pane).getByLabelText("region $env variable");
    fireEvent.change(name, { target: { value: "OPENAI_KEY" } });
    expect(within(pane).getByText("$env · OPENAI_KEY")).toBeInTheDocument();
  });

  it("wraps a value as a literal $secret with a masked input and a masked token", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    fireEvent.change(within(pane).getByLabelText("region mode"), { target: { value: "secret" } });
    expect(within(pane).getByLabelText("region $secret source")).toHaveValue("literal");
    const secret = within(pane).getByLabelText("region $secret value") as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.change(secret, { target: { value: "hunter2" } });
    // The masked token never renders the resolved value.
    expect(within(pane).getByText("$secret · ••••••")).toBeInTheDocument();
    expect(within(pane).queryByText(/hunter2/)).not.toBeInTheDocument();
  });

  it("composes {$secret:{$env:…}} through the source sub-selector", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    fireEvent.change(within(pane).getByLabelText("region mode"), { target: { value: "secret" } });
    fireEvent.change(within(pane).getByLabelText("region $secret source"), { target: { value: "env" } });
    fireEvent.change(within(pane).getByLabelText("region $secret $env variable"), { target: { value: "TOKEN" } });
    expect(within(pane).getByText("$secret · $env · TOKEN")).toBeInTheDocument();
  });

  it("does not render a mode selector on a type field", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    // `prompt` (the prompt text) is a type field; `model` a first-class config field — neither carries the selector.
    expect(within(pane).queryByLabelText("Prompt mode")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Model mode")).not.toBeInTheDocument();
  });

  it("masks a secret in an inherited (ghosted) display, never the resolved value", async () => {
    const seed = {
      format: FORMAT_VERSION,
      id: uuid(1),
      name: "flow",
      config: { apikey: { $secret: "supersecret" } },
      body: [{ type: "prompt", id: uuid(2), name: "alpha", prompt: "a" }],
    };
    const { canvas, pane } = await openPane(seed);
    selectNode(canvas, "alpha");
    // `apikey` is inherited from the file; its `$secret` shows as a masked token, not the literal.
    expect(within(pane).getByText("$secret · ••••••")).toBeInTheDocument();
    expect(within(pane).queryByText(/supersecret/)).not.toBeInTheDocument();
  });
});

describe("#387 wrapper round-trips through open/serialize", () => {
  it("preserves a composed {$secret:{$env:…}} config value byte-for-byte", () => {
    const composed = {
      format: FORMAT_VERSION,
      id: uuid(1),
      name: "flow",
      config: { token: { $secret: { $env: "TOK" } }, region: { $env: "REGION" } },
      body: [{ type: "prompt", id: uuid(2), name: "alpha", prompt: "a" }],
    };
    const opened = openWorkflowFile(JSON.stringify(composed), DEFAULT_PLUGINS);
    if (opened.status !== "opened") throw new Error(opened.status);
    const roundTripped = JSON.parse(canonicalSerialize(opened.file)) as typeof composed;
    expect(roundTripped.config).toEqual({ token: { $secret: { $env: "TOK" } }, region: { $env: "REGION" } });
  });
});
