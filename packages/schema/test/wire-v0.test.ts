import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/run-record.js";
import { fromWireRunRecord, toRootRunSummary, toWireRunRecord, type WireRunRecord } from "../src/wire-v0.js";

const record: RunRecord = {
  runId: "run-1",
  rootRunId: "root-1",
  parentRunId: "root-1",
  nodeId: "greet",
  worker: { type: "engine" },
  status: "succeeded",
  startedAt: "2026-07-27T10:00:00.000Z",
  finishedAt: "2026-07-27T10:00:01.000Z",
  inputRef: "root-1/run-1/input.json",
  outputRef: "root-1/run-1/output.json",
  usage: { input_tokens: 1, output_tokens: 2 },
  estimatedCostUsd: 0.001,
};

/** The nullable half, so the round trip is exercised on both shapes of a row. */
const emptyRecord: RunRecord = {
  runId: "root-1",
  rootRunId: "root-1",
  parentRunId: null,
  nodeId: null,
  worker: null,
  status: "pending",
  startedAt: null,
  finishedAt: null,
  inputRef: null,
  outputRef: null,
  usage: null,
  estimatedCostUsd: null,
};

describe("the v0 wire record", () => {
  it("round-trips a full record through the wire and back", () => {
    expect(fromWireRunRecord(toWireRunRecord(record))).toEqual(record);
  });

  it("round-trips a record whose every optional field is null", () => {
    expect(fromWireRunRecord(toWireRunRecord(emptyRecord))).toEqual(emptyRecord);
  });

  it("spells every field snake_case on the wire (server-api-v0.md §1)", () => {
    const wire = toWireRunRecord(record);
    expect(Object.keys(wire).sort()).toEqual([
      "estimated_cost_usd",
      "finished_at",
      "input_ref",
      "node_id",
      "output_ref",
      "parent_run_id",
      "root_run_id",
      "run_id",
      "started_at",
      "status",
      "usage",
      "worker",
    ]);
  });

  // Before #66 this shape was declared once in @path/server to encode and once in
  // @path/client-core to decode, in packages with no dependency between them — so a field renamed
  // on one side type-checked cleanly on both and broke only at runtime, in the browser.
  it("carries no field the domain record does not have, and drops none it does", () => {
    const wire = toWireRunRecord(record);
    expect(Object.keys(wire)).toHaveLength(Object.keys(record).length);
  });
});

describe("toRootRunSummary", () => {
  it("projects the four fields GET /v0/runs returns, and no others", () => {
    expect(toRootRunSummary(record)).toEqual({
      run_id: "run-1",
      status: "succeeded",
      started_at: "2026-07-27T10:00:00.000Z",
      finished_at: "2026-07-27T10:00:01.000Z",
    });
  });

  it("agrees with the full record on every field they share", () => {
    const summary = toRootRunSummary(record);
    const wire: WireRunRecord = toWireRunRecord(record);
    for (const key of Object.keys(summary) as (keyof typeof summary)[]) {
      expect(summary[key]).toEqual(wire[key]);
    }
  });
});
