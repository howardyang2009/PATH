import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/run-record.js";
import { toRootRunSummary, toWireRunRecord, type WireRunRecord } from "../src/wire-v0.js";

/**
 * The wire shape must carry every field of the domain record, under its snake_case name — checked
 * at compile time, because the one drift the code cannot catch by itself is a field added to
 * `RunRecord` and forgotten on the wire. `fromDbRow` fails to compile when that happens, but
 * `toWireRunRecord` does not: it builds a `WireRunRecord`, which simply doesn't have the field yet,
 * so a new column reaches the db and never reaches the API. This is `pnpm typecheck`'s business —
 * `tsconfig.json` covers `test` as well as `src`.
 *
 * The assertion is here rather than in `wire-v0.ts`, and `WireRunRecord` stays written out by hand:
 * a *derived* wire type would let a domain rename silently rename a field of the published v0 API
 * (server-api-v0.md §4). A test that fails and names the field is the outcome we want; a contract
 * that quietly follows the domain is not.
 */
type CamelToSnake<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Uppercase<Head>
    ? Head extends Lowercase<Head> // digits and separators are both, and pass through unchanged
      ? `${Head}${CamelToSnake<Tail>}`
      : `_${Lowercase<Head>}${CamelToSnake<Tail>}`
    : `${Head}${CamelToSnake<Tail>}`
  : S;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _WireCarriesEveryRecordField = Assert<Equal<keyof WireRunRecord, CamelToSnake<keyof RunRecord>>>;

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
  it("maps every field of a full record onto its wire name", () => {
    expect(toWireRunRecord(record)).toEqual({
      run_id: "run-1",
      root_run_id: "root-1",
      parent_run_id: "root-1",
      node_id: "greet",
      worker: { type: "engine" },
      status: "succeeded",
      started_at: "2026-07-27T10:00:00.000Z",
      finished_at: "2026-07-27T10:00:01.000Z",
      input_ref: "root-1/run-1/input.json",
      output_ref: "root-1/run-1/output.json",
      usage: { input_tokens: 1, output_tokens: 2 },
      estimated_cost_usd: 0.001,
    });
  });

  it("carries a record whose every optional field is null across as null, not as absent", () => {
    expect(toWireRunRecord(emptyRecord)).toEqual({
      run_id: "root-1",
      root_run_id: "root-1",
      parent_run_id: null,
      node_id: null,
      worker: null,
      status: "pending",
      started_at: null,
      finished_at: null,
      input_ref: null,
      output_ref: null,
      usage: null,
      estimated_cost_usd: null,
    });
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

  // "carries no field the domain record does not have, and drops none it does" used to be asserted
  // here by comparing key counts against the fixture above. `_WireCarriesEveryRecordField` states it
  // at compile time instead, over the types themselves — so it no longer depends on this file's
  // fixture being complete, and it fails in both directions rather than only when a field is added.
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
