import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { fileProblems, problemMarks, refLookupFor } from "../src/problems.js";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function step(id: number, name: string, extra: Record<string, unknown>): WorkflowNode {
  return { type: "prompt", id: uuid(id), name, prompt: "x", ...extra } as never;
}

function wrap(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body };
}

function refNode(id: number, name: string, ref: string): WorkflowNode {
  return { type: "workflow", id: uuid(id), name, ref } as never;
}

describe("#388 cross-node problems", () => {
  it("flags a dangling `${context.missing}` input read", () => {
    const file = wrap([step(2, "reader", { input: { q: "${context.missing}" } })]);
    const problems = fileProblems(file);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: uuid(2), nodeName: "reader", kind: "dangling-interpolation" });
    expect(problems[0]!.message).toContain("missing");
  });

  it("does not flag a context read a sibling publishes, whatever the order", () => {
    // Consumer authored before its producer — routine, must not be flagged (spec § save-with-warnings).
    const file = wrap([
      step(2, "reader", { input: { q: "${context.ready}" } }),
      step(3, "writer", { publish: { ready: "${output.a}" } }),
    ]);
    expect(fileProblems(file)).toHaveLength(0);
  });

  it("flags a dangling context read inside a leaf type field", () => {
    const file = wrap([step(2, "asker", { prompt: "Use ${context.gone} now" })]);
    const problems = fileProblems(file);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("dangling-interpolation");
  });

  it("does not flag output or config roots (author-trust / injected)", () => {
    const file = wrap([step(2, "s", { input: { a: "${output.x}", b: "${config.y}" } })]);
    expect(fileProblems(file)).toHaveLength(0);
  });

  it("flags a dangling condition path on a branch arm", () => {
    const file = wrap([
      {
        type: "branch",
        id: uuid(2),
        name: "gate",
        arms: [{ when: { type: "exists", path: "context.absent" }, node: step(3, "leg", {}) }],
      } as never,
    ]);
    const problems = fileProblems(file);
    const cond = problems.find((p) => p.kind === "dangling-condition");
    expect(cond).toBeDefined();
    expect(cond!.nodeId).toBe(uuid(2));
    expect(cond!.message).toContain("absent");
  });

  it("does not flag a condition path whose key is published", () => {
    const file = wrap([
      {
        type: "branch",
        id: uuid(2),
        name: "gate",
        arms: [{ when: { type: "exists", path: "context.flag" }, node: step(3, "leg", { publish: { flag: "${output.a}" } }) }],
      } as never,
    ]);
    expect(fileProblems(file).filter((p) => p.kind === "dangling-condition")).toHaveLength(0);
  });

  it("carries the publish conflict through as a problem, with jump-to-node fields", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "fan",
        join: "collect",
        branches: [step(2, "b1", { publish: { k: "${output.a}" } }), step(3, "b2", { publish: { k: "${output.a}" } })],
      } as never,
    ]);
    const problems = fileProblems(file);
    const conflict = problems.find((p) => p.kind === "publish-conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.nodeId).toBe(uuid(3));
    expect(conflict!.nodeName).toBe("b2");
  });

  it("de-duplicates the same dangling key repeated in one node", () => {
    const file = wrap([step(2, "s", { input: { a: "${context.gone}", b: "${context.gone}" } })]);
    expect(fileProblems(file)).toHaveLength(1);
  });

  it("marks every offending node, joining multiple messages for one node", () => {
    const file = wrap([
      {
        type: "while-do",
        id: uuid(2),
        name: "loop",
        condition: { type: "exists", path: "context.c1" },
        max_iterations: "${context.c2}",
        node: step(3, "body", {}),
      } as never,
    ]);
    const marks = problemMarks(fileProblems(file));
    expect(marks.has(uuid(2))).toBe(true);
    // both the dangling condition path and the dangling max_iterations read land on the one node
    expect(marks.get(uuid(2))).toContain("c1");
    expect(marks.get(uuid(2))).toContain("c2");
  });

  it("flags a `workflow`-ref whose target has no saved file yet (create-new, not saved)", () => {
    const file = wrap([refNode(2, "child", "flows/child.workflow.json")]);
    const problems = fileProblems(file, { filePath: "flows/parent.workflow.json", knownPaths: new Set() });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: uuid(2), nodeName: "child", kind: "dangling-ref" });
    expect(problems[0]!.message).toContain("child.workflow.json");
  });

  it("does not flag a `workflow`-ref whose target is a saved (discovered) file", () => {
    // Ref stored relative to the parent's directory; resolved against the known set clears the marker.
    const file = wrap([refNode(2, "child", "child.workflow.json")]);
    const known = new Set(["flows/child.workflow.json"]);
    const problems = fileProblems(file, { filePath: "flows/parent.workflow.json", knownPaths: known });
    expect(problems).toHaveLength(0);
  });

  it("does not check refs at all without a ref context (from-scratch root, discovery absent)", () => {
    const file = wrap([refNode(2, "child", "flows/child.workflow.json")]);
    expect(fileProblems(file)).toHaveLength(0);
  });

  it("does not flag an empty ref (target not yet chosen)", () => {
    const file = wrap([refNode(2, "child", "")]);
    expect(fileProblems(file, { filePath: "flows/parent.workflow.json", knownPaths: new Set() })).toHaveLength(0);
  });

  it("marks the node so the canvas ⚠ and the panel both name the dangling ref", () => {
    const file = wrap([refNode(2, "child", "child.workflow.json")]);
    const problems = fileProblems(file, { filePath: "flows/parent.workflow.json", knownPaths: new Set() });
    const marks = problemMarks(problems);
    expect(marks.get(uuid(2))).toContain("child.workflow.json");
  });

  it("suppresses the ref check before discovery loads (null known set) and for a pathless file", () => {
    // An empty set reads as "no files exist"; only a `null` set means "not loaded yet" and skips the check.
    expect(refLookupFor("flows/parent.workflow.json", null)).toBeUndefined();
    expect(refLookupFor(undefined, new Set())).toBeUndefined();
    expect(refLookupFor(null, new Set())).toBeUndefined();
    expect(refLookupFor("flows/parent.workflow.json", new Set())).toEqual({
      filePath: "flows/parent.workflow.json",
      knownPaths: new Set(),
    });
  });

  it("marks nothing for a clean file", () => {
    const file = wrap([step(2, "a", { input: { x: "${config.model}" }, publish: { done: "${output.a}" } })]);
    expect(fileProblems(file)).toHaveLength(0);
    expect(problemMarks(fileProblems(file)).size).toBe(0);
  });
});
