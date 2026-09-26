import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import { rerunBoundaryIndex, rerunDisposition } from "../src/rerun-disposition.js";

/**
 * The per-node Resume-from-K verdict (ADR 0036). The descent site and the `while-do` loop used to each
 * re-derive it — from overlapping sets, and from raw index math. This is its own test surface now.
 */

const step = (id: string): WorkflowNode => ({
  type: "binary",
  id,
  name: id,
  command: "node",
  args: ["-e", ""],
});

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

describe("rerunBoundaryIndex", () => {
  it("is the head's index in the body, so both producers read one position", () => {
    expect(rerunBoundaryIndex(body, ["a"])).toBe(0);
    expect(rerunBoundaryIndex(body, ["c"])).toBe(2);
    // An inner boundary is the same question one level down: only the head counts.
    expect(rerunBoundaryIndex(body, ["b", "inner"])).toBe(1);
  });

  it("is undefined for an empty suffix — plain Resume has no boundary at this level", () => {
    expect(rerunBoundaryIndex(body, [])).toBeUndefined();
  });

  it("throws the one invariant error for a head the body does not hold", () => {
    expect(() => rerunBoundaryIndex(body, ["nope"])).toThrow(
      'resume: rerun boundary node "nope" is not a top-level node of the workflow',
    );
  });
});

describe("rerunDisposition — a sequence body is transparent (ADR 0064)", () => {
  const seq = (id: string, inner: WorkflowNode[]): WorkflowNode => ({
    type: "sequence",
    id,
    name: id,
    body: inner,
  });
  // body: a, s{b, c, d}, e — the serial order is a, b, c, d, e. B = c.
  const staged: WorkflowNode[] = [
    step("a"),
    seq("s", [step("b"), step("c"), step("d")]),
    step("e"),
  ];

  it("indexes the boundary in serial order", () => {
    expect(rerunBoundaryIndex(staged, ["c"])).toBe(2);
  });

  it("classifies sequence children against a boundary inside the same sequence", () => {
    expect(rerunDisposition(staged, ["c"], "a")).toBe("reuse");
    expect(rerunDisposition(staged, ["c"], "b")).toBe("reuse");
    expect(rerunDisposition(staged, ["c"], "c")).toBe("rerun-entire");
    expect(rerunDisposition(staged, ["c"], "d")).toBe("rerun-entire");
    expect(rerunDisposition(staged, ["c"], "e")).toBe("rerun-entire");
    expect(rerunDisposition(staged, ["c", "inner"], "c")).toBe("descend");
  });

  it("classifies a sequence child against a first-level boundary", () => {
    expect(rerunDisposition(staged, ["e"], "c")).toBe("reuse");
    expect(rerunDisposition(staged, ["a"], "c")).toBe("rerun-entire");
  });
});
