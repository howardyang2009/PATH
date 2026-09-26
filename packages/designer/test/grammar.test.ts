import type { WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  carriesEnvelope,
  childSocketFlavor,
  socketAcceptsBody,
  socketAcceptsKind,
} from "../src/grammar.js";

describe("grammar — which kind snaps into which socket (#368)", () => {
  it("admits every step and controller kind in every socket flavour", () => {
    for (const flavor of ["sequence", "single", "branches"] as const) {
      for (const kind of [
        "prompt",
        "binary",
        "workflow",
        "parallel",
        "branch",
        "while-do",
        "sequence",
        "api-call",
      ]) {
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

  it("carriesEnvelope is true for a leaf/workflow type, false for every control block", () => {
    for (const type of ["prompt", "binary", "workflow", "api-call"])
      expect(carriesEnvelope(type)).toBe(true);
    for (const type of ["parallel", "branch", "while-do", "sequence", "checkpoint"])
      expect(carriesEnvelope(type)).toBe(false);
  });

  it("admits a template body where its insert form is legal (#578)", () => {
    const leaf = { type: "prompt" } as WorkflowNode;
    const checkpoint = { type: "checkpoint" } as WorkflowNode;
    // A list socket splices the nodes in, so each node must be legal there — every kind is, in a sequence.
    expect(socketAcceptsBody("sequence", [checkpoint])).toBe(true);
    expect(socketAcceptsBody("sequence", [leaf, checkpoint])).toBe(true);
    // A single slot or a parallel branch takes one node: a one-node body inserts bare, so its kind decides.
    expect(socketAcceptsBody("single", [leaf])).toBe(true);
    expect(socketAcceptsBody("single", [checkpoint])).toBe(false);
    expect(socketAcceptsBody("branches", [checkpoint])).toBe(false);
    // A 2+-node body is wrapped in a fresh sequence, where a checkpoint is legal.
    expect(socketAcceptsBody("single", [leaf, checkpoint])).toBe(true);
    expect(socketAcceptsBody("branches", [checkpoint, leaf])).toBe(true);
    // An empty body places nothing, so no socket opens for it.
    expect(socketAcceptsBody("sequence", [])).toBe(false);
  });
});
