import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { publishConflicts } from "../src/publish-conflicts.js";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function pub(id: number, name: string, publish: Record<string, string>): WorkflowNode {
  return { type: "prompt", id: uuid(id), name, prompt: "x", publish } as never;
}

function wrap(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body };
}

describe("#370 publish conflicts", () => {
  it("marks the later branch of a collect same-key race", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "fan",
        join: "collect",
        branches: [pub(2, "b1", { k: "${output.a}" }), pub(3, "b2", { k: "${output.a}" })],
      } as never,
    ]);
    const marks = publishConflicts(file);
    expect(marks.has(uuid(3))).toBe(true);
    expect(marks.has(uuid(2))).toBe(false);
  });

  it("does not mark a wait-one race (only the winner lands)", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "fan",
        join: "wait-one",
        branches: [pub(2, "b1", { k: "${output.a}" }), pub(3, "b2", { k: "${output.a}" })],
      } as never,
    ]);
    expect(publishConflicts(file).size).toBe(0);
  });

  it("marks a publish inside a do-not-wait branch, even nested", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "detach",
        join: "do-not-wait",
        branches: [
          {
            type: "sequence",
            id: uuid(11),
            name: "seq",
            body: [pub(2, "b1", { k: "${output.a}" })],
          } as never,
        ],
      } as never,
    ]);
    const marks = publishConflicts(file);
    expect(marks.has(uuid(2))).toBe(true);
  });

  it("marks nothing for a clean file", () => {
    const file = wrap([pub(2, "a", { k1: "${output.a}" }), pub(3, "b", { k2: "${output.b}" })]);
    expect(publishConflicts(file).size).toBe(0);
  });
});
