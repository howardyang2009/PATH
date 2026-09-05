import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { IdRow, NumberField, TextField, fillPlaceholderOnTab } from "../src/pane-controls.js";

/**
 * The pane's generic field vocabulary (`pane-controls.tsx`), lifted out of `properties-pane.tsx`. These
 * hit the atoms head-on — the coercion a number field does, the Tab-fills-placeholder handler, and the
 * confirmation gate on a re-key (ADR 0015) — without mounting the whole pane and a workflow buffer.
 */

describe("NumberField", () => {
  it("coerces an empty input to null and a typed value to a number", () => {
    const onChange = vi.fn();
    render(<NumberField label="max" value={5} onChange={onChange} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.change(input, { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });
});

describe("TextField", () => {
  it("passes the raw value through, empty string included", () => {
    const onChange = vi.fn();
    render(<TextField label="name" value="hi" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});

/** A controlled input under the delegated `fillPlaceholderOnTab` handler, to drive the placeholder-fill. */
function TabHarness({ placeholder }: { placeholder: string }): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <div onKeyDown={fillPlaceholderOnTab}>
      <input aria-label="field" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
    </div>
  );
}

describe("fillPlaceholderOnTab", () => {
  it("fills the placeholder into an empty field on Tab", () => {
    render(<TabHarness placeholder="${context.value}" />);
    const input = screen.getByLabelText("field") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("${context.value}");
  });

  it("leaves a field that already holds text alone", () => {
    render(<TabHarness placeholder="${context.value}" />);
    const input = screen.getByLabelText("field") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("typed");
  });
});

describe("IdRow", () => {
  it("gates a re-key behind a confirm, and Cancel disarms it", () => {
    const onReKey = vi.fn();
    render(<IdRow id="abc" onReKey={onReKey} what={'"step-one"'} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-key" }));
    // Armed: the warning shows and nothing has committed yet.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onReKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onReKey).not.toHaveBeenCalled();
  });

  it("commits the re-key only on Confirm", () => {
    const onReKey = vi.fn();
    render(<IdRow id="abc" onReKey={onReKey} what={'"step-one"'} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-key" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm re-key" }));
    expect(onReKey).toHaveBeenCalledTimes(1);
  });
});
