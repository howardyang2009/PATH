import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import { rerunDisposition } from "../src/rerun-disposition.js";

/**
 * The per-node Resume-from-K verdict (ADR 0036). The descent site and the `while-do` loop used to each
 * re-derive it — from overlapping sets, and from raw index math. This is its own test surface now.
 */

const step = (id: string): WorkflowNode => ({ type: "binary", id, name: id, command: "node", args: ["-e", ""] });

// body: a, b, c at top level. B is the rerun boundary's head at this level.
const body: WorkflowNode[] = [step("a"), step("b"), step("c")];

describe("rerunDisposition", () => {
  it("reuses every node on an empty suffix (plain Resume / off-path)", () => {
    for (const id of ["a", "b", "c"]) expect(rerunDisposition(body, [], id)).toBe("reuse");
  });

  it("reuses a node before B", () => {
    expect(rerunDisposition(body, ["b"], "a")).toBe("reuse");
  });

  it("rerun-entires a node after B", () => {
    expect(rerunDisposition(body, ["b"], "c")).toBe("rerun-entire");
  });

  it("rerun-entires B itself when B is the leaf boundary (B == K)", () => {
    expect(rerunDisposition(body, ["b"], "b")).toBe("rerun-entire");
  });

  it("descends B when an inner boundary follows (B is intermediate)", () => {
    expect(rerunDisposition(body, ["b", "inner"], "b")).toBe("descend");
    // its neighbours are unaffected: before-B still reuses, after-B still re-runs.
    expect(rerunDisposition(body, ["b", "inner"], "a")).toBe("reuse");
    expect(rerunDisposition(body, ["b", "inner"], "c")).toBe("rerun-entire");
  });

  it("degrades a node absent from the body to rerun-entire (re-run, never mis-reuse)", () => {
    expect(rerunDisposition(body, ["b"], "gone")).toBe("rerun-entire");
  });

  it("throws when the suffix head is not a top-level node (an invariant Project.resume guards)", () => {
    expect(() => rerunDisposition(body, ["nope"], "a")).toThrow(/not a top-level node/);
  });
});
