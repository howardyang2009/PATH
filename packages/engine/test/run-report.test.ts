import { describe, expect, it } from "vitest";
import type { ListEligibleResult, ResumeResult } from "../src/project.js";
import {
  formatRunsTable,
  type RunsTableRow,
  renderListEligible,
  renderResume,
  renderRunOutcome,
  SIGINT_EXIT_CODE,
} from "../src/run-report.js";

/**
 * The pure CLI outcome renderers (#architecture-deepening candidate 2). These pin the exit code, the
 * stdout lines and the stderr narration each outcome produces, asserted on the returned `RunReport`
 * value with no fake `io` — the split `emit` in `cli.ts` only writes what these decide.
 */

describe("renderRunOutcome", () => {
  it("narrates a cancel on stderr and exits on the SIGINT code", () => {
    expect(renderRunOutcome("cancelled", undefined)).toEqual({
      stdout: [],
      stderr: ["run cancelled"],
      exitCode: SIGINT_EXIT_CODE,
    });
  });

  it("carries the failure message and exits 1", () => {
    expect(renderRunOutcome("failed", "boom")).toEqual({
      stdout: [],
      stderr: ["run failed: boom"],
      exitCode: 1,
    });
  });

  it("notes an awaiting park but exits 0 — parked is neither done nor broken", () => {
    expect(renderRunOutcome("awaiting", undefined)).toEqual({
      stdout: [],
      stderr: ["run is awaiting completion of a person-activity step"],
      exitCode: 0,
    });
  });

  it("says nothing and exits 0 on success — the caller owns the happy-path output", () => {
    expect(renderRunOutcome("succeeded", undefined)).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
  });
});

describe("renderResume", () => {
  it("prints the successor root run id on stdout, then mirrors the run outcome", () => {
    const result: ResumeResult = {
      found: true,
      rootRunId: "root-2",
      status: "failed",
      output: {},
      error: "boom",
    };
    expect(renderResume(result)).toEqual({
      stdout: ["root-2"],
      stderr: ["run failed: boom"],
      exitCode: 1,
    });
  });

  it("prints the root run id even on success, so the operator can chain another resume", () => {
    const result: ResumeResult = {
      found: true,
      rootRunId: "root-2",
      status: "succeeded",
      output: {},
    };
    expect(renderResume(result)).toEqual({ stdout: ["root-2"], stderr: [], exitCode: 0 });
  });

  it("exits 1 with the engine's own message for an unknown root run", () => {
    expect(renderResume({ found: false, error: "no run found" })).toEqual({
      stdout: [],
      stderr: ["no run found"],
      exitCode: 1,
    });
  });

  it("exits 1 with the refusal message verbatim for a Resume-from-K refusal", () => {
    expect(renderResume({ found: false, refusal: { status: 409, message: "K diverged" } })).toEqual(
      {
        stdout: [],
        stderr: ["K diverged"],
        exitCode: 1,
      },
    );
  });
});

describe("renderListEligible", () => {
  it("exits 1 with the engine's message when the source tree is not found", () => {
    expect(renderListEligible({ found: false, error: "no run found" })).toEqual({
      stdout: [],
      stderr: ["no run found"],
      exitCode: 1,
    });
  });

  it("renders the four-column listing, mapping each verdict reason to its §6 cell wording", () => {
    const result: ListEligibleResult = {
      found: true,
      rows: [
        {
          runId: "root-1",
          nodeName: null,
          status: "succeeded",
          verdict: { eligible: false, reason: "root-run" },
        },
        { runId: "s-1", nodeName: "build", status: "succeeded", verdict: { eligible: true } },
        {
          runId: "s-2",
          nodeName: "loop-step",
          status: "succeeded",
          verdict: { eligible: false, reason: "in-body", container: "loop" },
        },
        {
          runId: "p-2",
          nodeName: "check",
          status: "succeeded",
          verdict: { eligible: false, reason: "pass-run" },
        },
      ],
    };
    const report = renderListEligible(result);
    expect(report.exitCode).toBe(0);
    expect(report.stderr).toEqual([]);
    expect(report.stdout).toHaveLength(1);
    const lines = report.stdout[0]!.split("\n");
    expect(lines[0]).toContain("run-id");
    expect(lines[0]).toContain("eligible?");
    // The root row renders `-` for its missing node name and the root-run reason.
    expect(lines[1]).toMatch(/root-1\s+-\s+succeeded\s+root run \(never a boundary\)/);
    expect(lines[2]).toMatch(/s-1\s+build\s+succeeded\s+yes/);
    expect(lines[3]).toContain("inside a loop body");
    // A goto pass container is never a boundary; K is a node inside it.
    expect(lines[4]).toMatch(/p-2\s+check\s+succeeded\s+goto pass \(never a boundary\)/);
  });
});

describe("formatRunsTable", () => {
  it("space-aligns every column but the last, sharing the layout with --list-eligible", () => {
    const rows: RunsTableRow[] = [
      ["root-abc", "wf-one", "succeeded", "t0", "t1", "-"],
      ["root-de", "w", "failed", "t2", "t3", "root-abc"],
    ];
    const lines = formatRunsTable(rows).split("\n");
    // Header line names every column; the workflow column pads to its widest cell ("wf-one").
    expect(lines[0]).toContain("root-run-id");
    expect(lines[1]).toContain("wf-one   ");
    expect(lines[2]).toContain("w        ");
    // The last column carries no trailing padding.
    expect(lines[1]!.endsWith("-")).toBe(true);
  });
});
