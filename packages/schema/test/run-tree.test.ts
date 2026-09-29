import { describe, expect, it } from "vitest";
import type { RunStatus } from "../src/run-status.js";
import {
  childrenByParent,
  displayStatusByRun,
  findRootRun,
  pathToRoot,
  subtree,
} from "../src/run-tree.js";

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
    expect(
      byParent
        .get("root")!
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      byParent
        .get("a")!
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["a1", "a2"]);
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
    expect(
      subtree(complete, "a")
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["a", "a1", "a2"]);
  });

  it("returns just the start row for a leaf", () => {
    expect(subtree(complete, "a1").map((r) => r.runId)).toEqual(["a1"]);
  });

  it("returns the whole tree from the root", () => {
    expect(
      subtree(complete, "root")
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["a", "a1", "a2", "b", "root"]);
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

describe("pathToRoot", () => {
  it("returns the root→…→start chain, inclusive of both ends", () => {
    expect(pathToRoot(complete, "a1").map((r) => r.runId)).toEqual(["root", "a", "a1"]);
  });

  it("returns just the root when start is the root", () => {
    expect(pathToRoot(complete, "root").map((r) => r.runId)).toEqual(["root"]);
  });

  it("is empty when no row has the start id", () => {
    expect(pathToRoot(complete, "nope")).toEqual([]);
  });

  it("stops at the highest reachable ancestor when a parent row is missing", () => {
    // `mid`'s parent row is absent, so the walk cannot reach the real root.
    const partial: Row[] = [
      { runId: "mid", parentRunId: "gone" },
      { runId: "leaf", parentRunId: "mid" },
    ];
    expect(pathToRoot(partial, "leaf").map((r) => r.runId)).toEqual(["mid", "leaf"]);
  });
});

describe("displayStatusByRun", () => {
  const run = (runId: string, parentRunId: string | null, status: RunStatus = "running") => ({
    runId,
    parentRunId,
    status,
  });

  it("returns `awaiting` for a running run with an awaiting run anywhere below it", () => {
    const display = displayStatusByRun([
      run("root", null),
      run("mid", "root"),
      run("leaf", "mid", "awaiting"),
    ]);
    expect(display.get("root")).toBe("awaiting");
    expect(display.get("mid")).toBe("awaiting");
    expect(display.get("leaf")).toBe("awaiting");
  });

  it("returns the record status when no descendant is awaiting", () => {
    expect(displayStatusByRun([run("root", null), run("mid", "root")]).get("root")).toBe("running");
  });

  it("returns a run's own status untouched when it is not running", () => {
    const display = displayStatusByRun([
      run("root", null, "succeeded"),
      run("leaf", "root", "awaiting"),
    ]);
    expect(display.get("leaf")).toBe("awaiting");
    expect(display.get("root")).toBe("succeeded");
    expect(displayStatusByRun([run("root", null, "pending")]).get("root")).toBe("pending");
  });

  it("flips only the branch that holds the awaiting leaf", () => {
    const display = displayStatusByRun([
      run("root", null),
      run("branch-a", "root"),
      run("leaf-a", "branch-a", "awaiting"),
      run("branch-b", "root"),
      run("leaf-b", "branch-b", "running"),
    ]);
    expect(display.get("branch-a")).toBe("awaiting");
    expect(display.get("branch-b")).toBe("running");
  });
});
