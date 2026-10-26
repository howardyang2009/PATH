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
    worker_name: "spawn",
  };
}

function finished(
  seq: number,
  nodeId: string | null,
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
): LogEvent {
  return {
    type: "step-finished",
    seq,
    ts: `2026-07-25T10:00:0${seq}.000Z`,
    run_id: "run_a",
    node_id: nodeId,
    node_name: nodeId,
    status,
  };
}

/** jsdom gives every element zero size; a scrollable list has to be faked to test following. */
function sizeList(list: HTMLElement, { scrollTop }: { scrollTop: number }): void {
  Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 200, configurable: true });
  list.scrollTop = scrollTop;
}

describe("Narrative", () => {
  it("renders one row per event in seq order, newest last", () => {
    render(
      <Narrative
        events={[started(1, null), started(2, "step-a"), finished(3, "step-a", "succeeded")]}
        stream="live"
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-seq"))).toEqual(["1", "2", "3"]);
    // The row names the node by both its human name and its id (here the fixture uses one value for
    // both).
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

  it("surfaces a parked run as waiting, not reconnecting, and not an error", () => {
    render(<Narrative events={[started(1, null)]} stream="waiting" />);

    const indicator = screen.getByTestId("stream-indicator");
    expect(indicator).toHaveAttribute("data-phase", "waiting");
    expect(indicator).toHaveTextContent("waiting for completion");
    expect(indicator).not.toHaveTextContent("reconnecting");
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

describe("Narrative lines in en", () => {
  const base = {
    seq: 0,
    ts: "2026-07-25T10:00:00.000Z",
    run_id: "run_a",
    node_id: "n1",
    node_name: "s",
  };
  const trace = { type: "exists", path: "previous.status", outcome: "true" } as const;
  const lines: [LogEvent, string][] = [
    [
      { ...base, type: "step-started", step_type: "binary", worker_name: "spawn" },
      "s (n1) started · spawn",
    ],
    [
      {
        ...base,
        node_id: null,
        node_name: null,
        type: "step-started",
        step_type: "workflow",
        worker_name: "workflow",
      },
      "root started · workflow",
    ],
    [{ ...base, type: "step-awaiting", assignee: null }, "s (n1) awaiting completion"],
    [{ ...base, type: "step-finished", status: "succeeded" }, "s (n1) succeeded"],
    [
      { ...base, type: "step-finished", status: "failed", error: "exit 1: boom" },
      "s (n1) failed · exit 1: boom",
    ],
    [{ ...base, type: "checkpoint-passed", trace }, "checkpoint s (n1) passed"],
    [{ ...base, type: "checkpoint-failed", trace }, "checkpoint s (n1) failed"],
    [{ ...base, type: "branch-taken", arm: 0, trace }, "branch s (n1) took arm 0"],
    [
      { ...base, type: "branch-taken", arm: "else", trace: null },
      "branch s (n1) took the else arm",
    ],
    [{ ...base, type: "branch-no-match", traces: [trace] }, "branch s (n1) matched no arm"],
    [
      { ...base, type: "join-applied", branches: ["a", "b"], published_keys: ["k"] },
      "join s (n1) applied · branches a, b · published k",
    ],
    [
      { ...base, type: "join-applied", branches: ["a"], published_keys: [] },
      "join s (n1) applied · branches a",
    ],
    [
      { ...base, type: "run-cancelled", cause: "operator", cause_run_id: null },
      "s (n1) cancelled by the operator",
    ],
    [
      { ...base, type: "run-cancelled", cause: "sibling-failed", cause_run_id: "run_b" },
      "s (n1) cancelled · cause run_b",
    ],
    [{ ...base, type: "iteration-started", iteration: 2, trace }, "while-do s (n1) iteration 2"],
    [
      { ...base, type: "loop-exited", reason: "condition-false", iterations: 3, trace },
      "while-do s (n1) exited after 3 iterations · condition-false",
    ],
    [{ ...base, node_id: null, node_name: null, type: "pass-started", pass: 1 }, "pass 1"],
    [{ ...base, node_name: "g", type: "pass-started", pass: 2 }, "pass 2 opened by goto g (n1)"],
    [
      {
        ...base,
        type: "goto-taken",
        target_node_id: "n2",
        target_node_name: "B",
        jump: 2,
        max_jumps: 3,
        pass: 3,
      },
      "goto s (n1) jumped to B · jump 2/3 · pass 3",
    ],
    [
      {
        ...base,
        type: "goto-exhausted",
        target_node_id: "n2",
        target_node_name: "B",
        max_jumps: 3,
        pass: 4,
      },
      "goto s (n1) exhausted · max_jumps 3 · target B",
    ],
    [{ ...base, type: "reuse-marker", original_run_id: "run_0" }, "s (n1) reused from run_0"],
  ];

  it("renders every event type's line as before", () => {
    const events = lines.map(([event], index) => ({ ...event, seq: index + 1 }));
    const { container } = render(<Narrative events={events} stream="closed" />);
    const texts = [...container.querySelectorAll(".event-msg")].map((el) =>
      el.textContent?.replace(/^[^\w(]+/u, ""),
    );
    expect(texts).toEqual(lines.map(([, text]) => text));
  });
});
