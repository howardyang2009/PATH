import { describe, expect, it } from "vitest";
import { childrenByParent, findRootRun, subtree } from "../src/run-tree.js";

interface Row {
  runId: string;
  parentRunId: string | null;
}

/** root → a → (a1, a2); root → b. A complete two-level tree. */
const complete: Row[] = [
  { runId: "root", parentRunId: null },
  { runId: "a", parentRunId: "root" },
  { runId: "b", parentRunId: "root" },
  { runId: "a1", parentRunId: "a" },
  { runId: "a2", parentRunId: "a" },
];

describe("childrenByParent", () => {
  it("groups non-root rows under their parent, and omits the root as a key", () => {
    const byParent = childrenByParent(complete);
    expect(byParent.get("root")!.map((r) => r.runId).sort()).toEqual(["a", "b"]);
    expect(byParent.get("a")!.map((r) => r.runId).sort()).toEqual(["a1", "a2"]);
    // The root is never filed as a child, so no key resolves to it.
    expect([...byParent.values()].flat().some((r) => r.runId === "root")).toBe(false);
  });

  it("files an orphan under orphanTo so a root-down walk still reaches it", () => {
    // `lost`'s parent row has not arrived — a live incomplete stream (buildRunTree's case).
    const streamed: Row[] = [
      { runId: "root", parentRunId: null },
      { runId: "lost", parentRunId: "not-here-yet" },
    ];
    const byParent = childrenByParent(streamed, { orphanTo: "root" });
    expect(byParent.get("root")!.map((r) => r.runId)).toEqual(["lost"]);
    expect(byParent.has("not-here-yet")).toBe(false);
  });

  it("without orphanTo, an unknown parent is left as its own key (complete-tree case)", () => {
    const byParent = childrenByParent([{ runId: "x", parentRunId: "missing" }]);
    expect(byParent.get("missing")!.map((r) => r.runId)).toEqual(["x"]);
  });
});

describe("subtree", () => {
  it("returns the start row and every transitive descendant, flat", () => {
    expect(subtree(complete, "a").map((r) => r.runId).sort()).toEqual(["a", "a1", "a2"]);
  });

  it("returns just the start row for a leaf", () => {
    expect(subtree(complete, "a1").map((r) => r.runId)).toEqual(["a1"]);
  });

  it("returns the whole tree from the root", () => {
    expect(subtree(complete, "root").map((r) => r.runId).sort()).toEqual(["a", "a1", "a2", "b", "root"]);
  });

  it("is empty when no row has the start id", () => {
    expect(subtree(complete, "nope")).toEqual([]);
  });
});

describe("findRootRun", () => {
  it("finds the parentless row", () => {
    expect(findRootRun(complete)?.runId).toBe("root");
  });

  it("is undefined when the tree has rows but no root of its own", () => {
    expect(findRootRun([{ runId: "child-only", parentRunId: "root" }])).toBeUndefined();
  });
});
