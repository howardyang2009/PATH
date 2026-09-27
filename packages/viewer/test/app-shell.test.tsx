import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/app-shell.js";

/** The shell's own seam: the two column rails and the left rail's row split. Each divider is a
 * `separator` a screen reader can nudge, and each persists under its own `localStorage` key. */

const RAILS_KEY = "path.viewer.rail-widths";
const SPLIT_KEY = "path.viewer.workflows-height";

function renderShell() {
  return render(
    <AppShell
      workflows={<p>workflows</p>}
      runs={<p>runs</p>}
      detail={<p>detail</p>}
      nodeIo={<p>node io</p>}
    />,
  );
}

/** jsdom leaves every element `clientHeight === 0`; pin it so the row clamp has real room. */
function withClientHeight(px: number) {
  const spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(px);
  return () => spy.mockRestore();
}

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());

  it("frames the four named panes and their separators", () => {
    renderShell();

    for (const name of ["Workflows", "Runs", "Run detail", "Node I/O/C/E"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    const left = screen.getByRole("separator", { name: "Resize runs pane" });
    expect(left).toHaveAttribute("aria-orientation", "vertical");
    expect(left).toHaveAttribute("aria-valuenow", "300");
    expect(screen.getByRole("separator", { name: "Resize node I/O/C/E pane" })).toHaveAttribute(
      "aria-valuenow",
      "340",
    );
  });

  it("nudges each column by arrow keys and mirrors the right rail's sign", () => {
    renderShell();
    const left = screen.getByRole("separator", { name: "Resize runs pane" });
    const right = screen.getByRole("separator", { name: "Resize node I/O/C/E pane" });

    fireEvent.keyDown(left, { key: "ArrowRight" });
    expect(left).toHaveAttribute("aria-valuenow", "308");
    // The right rail's handle sits on its left edge, so the same key shrinks it.
    fireEvent.keyDown(right, { key: "ArrowRight" });
    expect(right).toHaveAttribute("aria-valuenow", "332");

    fireEvent.keyDown(left, { key: "ArrowLeft", shiftKey: true });
    expect(left).toHaveAttribute("aria-valuenow", "276");
  });

  it("persists both column widths under one key", () => {
    renderShell();

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize runs pane" }), {
      key: "ArrowRight",
    });

    expect(JSON.parse(localStorage.getItem(RAILS_KEY) ?? "[]")).toEqual([308, 340]);
  });

  it("resizes the left rail's workflows panel within its clamp", () => {
    const restore = withClientHeight(600);
    try {
      renderShell();
      const split = screen.getByRole("separator", { name: "Resize workflows panel" });
      expect(split).toHaveAttribute("aria-orientation", "horizontal");
      expect(split).toHaveAttribute("aria-valuenow", "220");

      fireEvent.keyDown(split, { key: "ArrowDown" });
      expect(split).toHaveAttribute("aria-valuenow", "228");

      // 600 minus the runs list's floor (140) is the cap.
      for (let i = 0; i < 100; i++) fireEvent.keyDown(split, { key: "ArrowDown", shiftKey: true });
      expect(split).toHaveAttribute("aria-valuenow", "460");
      expect(JSON.parse(String(localStorage.getItem(SPLIT_KEY)))).toBe(460);
    } finally {
      restore();
    }
  });
});
