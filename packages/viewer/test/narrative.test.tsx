import type { LogEvent, RunStatus } from "@path/client-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Narrative } from "../src/narrative.js";
import { STATUS_GLYPH } from "../src/status-glyph.js";

function started(seq: number, nodeId: string | null): LogEvent {
  return {
    type: "step-started",
    seq,
    ts: `2026-07-25T10:00:0${seq}.000Z`,
    run_id: "run_a",
    node_id: nodeId,
    node_name: nodeId,
    step_type: "binary",
    worker: { type: "engine" },
  };
}

function finished(seq: number, nodeId: string | null, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">): LogEvent {
  return { type: "step-finished", seq, ts: `2026-07-25T10:00:0${seq}.000Z`, run_id: "run_a", node_id: nodeId, node_name: nodeId, status };
}

/** jsdom gives every element zero size; a scrollable list has to be faked to test following. */
function sizeList(list: HTMLElement, { scrollTop }: { scrollTop: number }): void {
  Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 200, configurable: true });
  list.scrollTop = scrollTop;
}

describe("Narrative", () => {
  it("renders one row per event in seq order, newest last", () => {
    render(<Narrative events={[started(1, null), started(2, "step-a"), finished(3, "step-a", "succeeded")]} stream="live" />);

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-seq"))).toEqual(["1", "2", "3"]);
    // The row names the node by both its human name and its id (here the fixture uses one value for both).
    expect(rows[2]).toHaveTextContent("step-a (step-a) succeeded");
  });

  it("marks a failed step with the failed status and its glyph, not with a hue alone", () => {
    render(<Narrative events={[finished(1, "step-a", "failed")]} stream="live" />);

    const row = screen.getAllByRole("listitem")[0]!;
    expect(row).toHaveAttribute("data-status", "failed");
    expect(row).toHaveTextContent(STATUS_GLYPH.failed);
    expect(row).toHaveTextContent("step-a (step-a) failed");
  });

  it("gives a pure control-flow event no status of its own", () => {
    const joinApplied: LogEvent = {
      type: "join-applied",
      seq: 1,
      ts: "2026-07-25T10:00:01.000Z",
      run_id: "run_a",
      node_id: "fan",
      node_name: "fan",
      branches: ["a", "b"],
      published_keys: [],
    };
    render(<Narrative events={[joinApplied]} stream="live" />);

    expect(screen.getAllByRole("listitem")[0]!).not.toHaveAttribute("data-status");
  });

  it("shows the seq of each event — the ordering truth, not the timestamp", () => {
    render(<Narrative events={[started(7, "step-a")]} stream="live" />);

    expect(screen.getByTestId("event-seq-7")).toHaveTextContent("7");
  });

  it("says the stream is live while the run is executing", () => {
    render(<Narrative events={[started(1, null)]} stream="live" />);

    const indicator = screen.getByTestId("stream-indicator");
    expect(indicator).toHaveAttribute("data-phase", "live");
    expect(indicator).toHaveTextContent("live");
  });

  it("says the narrative is complete once the stream closed for good", () => {
    render(<Narrative events={[finished(1, null, "succeeded")]} stream="closed" />);

    expect(screen.getByTestId("stream-indicator")).toHaveTextContent("complete");
  });

  it("surfaces a dropped stream as reconnecting, not as an error", () => {
    render(<Narrative events={[started(1, null)]} stream="reconnecting" />);

    const indicator = screen.getByTestId("stream-indicator");
    expect(indicator).toHaveAttribute("data-phase", "reconnecting");
    expect(indicator).toHaveTextContent("reconnecting");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a stream that will not come back", () => {
    render(<Narrative events={[]} stream="failed" />);

    expect(screen.getByTestId("stream-indicator")).toHaveTextContent("stream lost");
  });

  it("says nothing has been logged yet rather than showing an empty list", () => {
    render(<Narrative events={[]} stream="live" />);

    expect(screen.getByTestId("narrative-empty")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("follows the tail as events arrive", () => {
    const { rerender } = render(<Narrative events={[started(1, null)]} stream="live" />);
    const list = screen.getByTestId("narrative-events");
    sizeList(list, { scrollTop: 0 });

    rerender(<Narrative events={[started(1, null), started(2, "step-a")]} stream="live" />);

    expect(list.scrollTop).toBe(1000);
  });

  it("stops following once the operator scrolls up to read history, and resumes on request", () => {
    const { rerender } = render(<Narrative events={[started(1, null)]} stream="live" />);
    const list = screen.getByTestId("narrative-events");
    sizeList(list, { scrollTop: 100 });

    fireEvent.scroll(list);
    rerender(<Narrative events={[started(1, null), started(2, "step-a")]} stream="live" />);

    // A live log that yanks the viewport while it is being read is unreadable — the new event lands
    // without moving the scroll position.
    expect(list.scrollTop).toBe(100);

    fireEvent.click(screen.getByTestId("narrative-follow"));

    expect(list.scrollTop).toBe(1000);
  });

  it("offers no resume control while it is already following", () => {
    render(<Narrative events={[started(1, null)]} stream="live" />);

    expect(screen.queryByTestId("narrative-follow")).not.toBeInTheDocument();
  });
});
