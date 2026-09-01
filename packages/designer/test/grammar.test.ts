import { describe, expect, it } from "vitest";
import { childSocketFlavor, socketAcceptsKind } from "../src/grammar.js";
import type { WorkflowNode } from "@path/schema";

describe("grammar — which kind snaps into which socket (#368)", () => {
  it("admits every step and logicer kind in every socket flavour", () => {
    for (const flavor of ["sequence", "single", "branches"] as const) {
      for (const kind of ["prompt", "binary", "workflow", "parallel", "branch", "while-do", "sequence", "api-call"]) {
        expect(socketAcceptsKind(flavor, kind)).toBe(true);
      }
    }
  });

  it("admits a checkpoint only in a sequence-flavoured list, never a single slot or a parallel branch", () => {
    expect(socketAcceptsKind("sequence", "checkpoint")).toBe(true);
    expect(socketAcceptsKind("single", "checkpoint")).toBe(false);
    expect(socketAcceptsKind("branches", "checkpoint")).toBe(false);
  });

  it("maps each block to the flavour of its child slots", () => {
    const seq = { type: "sequence" } as WorkflowNode;
    const par = { type: "parallel" } as WorkflowNode;
    const wh = { type: "while-do" } as WorkflowNode;
    const br = { type: "branch" } as WorkflowNode;
    const leaf = { type: "prompt" } as WorkflowNode;
    expect(childSocketFlavor(seq)).toBe("sequence");
    expect(childSocketFlavor(par)).toBe("branches");
    expect(childSocketFlavor(wh)).toBe("single");
    expect(childSocketFlavor(br)).toBe("single");
    expect(childSocketFlavor(leaf)).toBeNull();
  });
});
