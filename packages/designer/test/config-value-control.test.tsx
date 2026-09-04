import type { ConfigValue } from "@path/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigValueControl } from "../src/config-value-control.js";

/**
 * The config-value control is the pane's UI adapter over the `config-value.ts` algebra. These tests hit
 * it directly — the seam the extraction bought (#370, § `$env` / `$secret` authoring) — asserting each
 * mode transition and edit lands the exact `ConfigValue` shape the algebra produces.
 */
describe("ConfigValueControl", () => {
  const renderControl = (value: ConfigValue) => {
    const onChange = vi.fn<(v: ConfigValue) => void>();
    render(<ConfigValueControl value={value} onChange={onChange} label="k" />);
    return onChange;
  };

  it("edits a literal string in place", () => {
    const onChange = renderControl("hi");
    fireEvent.change(screen.getByLabelText("k"), { target: { value: "bye" } });
    expect(onChange).toHaveBeenCalledWith("bye");
  });

  it("switches literal → $env, clearing to an empty $env wrapper", () => {
    const onChange = renderControl("hi");
    fireEvent.change(screen.getByLabelText("k mode"), { target: { value: "env" } });
    expect(onChange).toHaveBeenCalledWith({ $env: "" });
  });

  it("edits an $env variable name and shows its reference-only chip", () => {
    const onChange = renderControl({ $env: "TOKEN" });
    expect(screen.getByText("$env · TOKEN")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("k $env variable"), { target: { value: "OTHER" } });
    expect(onChange).toHaveBeenCalledWith({ $env: "OTHER" });
  });

  it("composes an env-sourced $secret from its source sub-selector", () => {
    const onChange = renderControl({ $secret: "" });
    fireEvent.change(screen.getByLabelText("k $secret source"), { target: { value: "env" } });
    expect(onChange).toHaveBeenCalledWith({ $secret: { $env: "" } });
  });

  it("masks a literal secret and never renders its value", () => {
    renderControl({ $secret: "hunter2" });
    expect(screen.getByText("$secret · ••••••")).toBeInTheDocument();
    expect((screen.getByLabelText("k $secret value") as HTMLInputElement).type).toBe("password");
  });

  it("renders a non-editable nested value read-only, with no controls", () => {
    renderControl({ nested: true } as unknown as ConfigValue);
    expect(screen.queryByLabelText("k mode")).toBeNull();
  });
});
