import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fillPlaceholderOnTab, NumberField, TextField } from "../src/pane-controls.js";

/**
 * The pane's generic field vocabulary (`pane-controls.tsx`), lifted out of `properties-pane.tsx`.
 * These hit the atoms head-on — the coercion a number field does and the Tab-fills-placeholder
 * handler — without mounting the whole pane and a workflow buffer.
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

/** A controlled input under the delegated `fillPlaceholderOnTab` handler, to drive the
 * placeholder-fill. */
function TabHarness({ placeholder }: { placeholder: string }): JSX.Element {
  const [value, setValue] = useState("");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: harness delegating Tab to its input.
    <div onKeyDown={fillPlaceholderOnTab}>
      <input
        aria-label="field"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
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
