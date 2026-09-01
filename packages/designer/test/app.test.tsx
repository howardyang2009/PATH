import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";

describe("Designer tracer bullet (#366)", () => {
  it("renders the authoring shell, not the read-only Viewer", () => {
    render(<App />);
    expect(screen.getByText("PATH")).toBeInTheDocument();
    expect(screen.getByText("designer · authoring")).toBeInTheDocument();
  });

  it("shows the palette shell split into Steps and Blocks", () => {
    render(<App />);
    const palette = screen.getByRole("region", { name: "Palette" });

    const steps = within(palette).getByRole("region", { name: "Steps" });
    // The static placeholder trio the first-class editors will cover.
    expect(within(steps).getByText("Prompt")).toBeInTheDocument();
    expect(within(steps).getByText("Binary")).toBeInTheDocument();
    expect(within(steps).getByText("Workflow")).toBeInTheDocument();

    const blocks = within(palette).getByRole("region", { name: "Blocks" });
    // The four logicers plus checkpoint, fixed by the grammar.
    for (const label of ["Parallel", "Branch", "While-do", "Sequence", "Checkpoint"]) {
      expect(within(blocks).getByText(label)).toBeInTheDocument();
    }
  });

  it("shows an empty canvas region", () => {
    render(<App />);
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    expect(within(canvas).getByText("Empty canvas")).toBeInTheDocument();
  });
});
