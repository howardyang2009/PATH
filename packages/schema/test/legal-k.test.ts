import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import type { RunStatus } from "../src/run-status.js";
import { classifyLevelK, type LegalKLevelRun } from "../src/legal-k.js";

/**
 * The per-level legal-K taxonomy (spec §5), the one predicate the engine authority and the client's
 * eager mirror both drive. The two surfaces used to spell it twice; this is its own test surface now.
 */

// A leaf step node; the human id doubles as `id` and `name`, as the structural tests do.
const step = (id: string): WorkflowNode => ({ type: "binary", id, name: id, command: "node", args: ["-e", ""] });

// A while-do wrapping one leaf — a control body, so its inner node is an illegal K locus (#3).
const loop = (id: string, inner: WorkflowNode): WorkflowNode => ({
  type: "while-do",
  id,
  name: id,
  condition: { type: "exists", path: "context.x" },
  max_iterations: 2,
  node: inner,
});

// body: a, b, c at top level. The rows put a/b/c under one scope run "scope".
const body: WorkflowNode[] = [step("a"), step("b"), step("c")];
const run = (nodeId: string, status: RunStatus): LegalKLevelRun => ({ parentRunId: "scope", nodeId, status });
const allSucceeded: LegalKLevelRun[] = [run("a", "succeeded"), run("b", "succeeded"), run("c", "succeeded")];

describe("classifyLevelK — the legal path", () => {
  it("passes a top-level, succeeded K with a fully-succeeded prefix", () => {
    expect(classifyLevelK({ body, rows: allSucceeded, scopeRunId: "scope", nodeId: "b", leafStatus: "succeeded" })).toEqual({
      ok: true,
    });
  });

  it("does not gate the leaf's own status when it is an intermediate path node (leafStatus null)", () => {
    // The prefix (a) succeeded, so an intermediate b passes even though its own run failed: it is
    // descended and re-run, not reused.
    const rows = [run("a", "succeeded"), run("b", "failed")];
    expect(classifyLevelK({ body, rows, scopeRunId: "scope", nodeId: "b", leafStatus: null })).toEqual({ ok: true });
  });
});

describe("classifyLevelK — the refusal taxonomy (spec §5)", () => {
  it("#2 not-in-file — the node id is nowhere in the body", () => {
    expect(classifyLevelK({ body, rows: allSucceeded, scopeRunId: "scope", nodeId: "gone", leafStatus: "succeeded" })).toEqual({
      ok: false,
      reason: "not-in-file",
    });
  });

  it("#3 in-body — present, but inside a control body, and it names the enclosing logicer", () => {
    const withLoop: WorkflowNode[] = [step("a"), loop("spin", step("inner"))];
    expect(classifyLevelK({ body: withLoop, rows: allSucceeded, scopeRunId: "scope", nodeId: "inner", leafStatus: "succeeded" })).toEqual(
      // The locus vocabulary spells while-do as `loop` (ControlBlockKind, spec §6).
      { ok: false, reason: "in-body", container: "loop" },
    );
  });

  it("#4 not-succeeded — a leaf K whose own run did not succeed", () => {
    expect(classifyLevelK({ body, rows: allSucceeded, scopeRunId: "scope", nodeId: "b", leafStatus: "failed" })).toEqual({
      ok: false,
      reason: "not-succeeded",
    });
  });

  it("#5 prefix-unsucceeded — a ran-but-unsucceeded node before K", () => {
    const rows = [run("a", "failed"), run("b", "succeeded")];
    expect(classifyLevelK({ body, rows, scopeRunId: "scope", nodeId: "b", leafStatus: "succeeded" })).toEqual({
      ok: false,
      reason: "prefix-unsucceeded",
    });
  });

  it("#4 wins over #5 — a not-succeeded leaf is reported even when its prefix also broke", () => {
    const rows = [run("a", "failed"), run("b", "failed")];
    expect(classifyLevelK({ body, rows, scopeRunId: "scope", nodeId: "b", leafStatus: "failed" })).toEqual({
      ok: false,
      reason: "not-succeeded",
    });
  });
});

describe("classifyLevelK — a skipped prefix path is not a broken one (#5)", () => {
  it("admits a prefix node that never ran under scope (an untaken arm, a zero-iteration loop)", () => {
    // b's row is absent entirely: it was skipped, so it does not gate K at c.
    const rows = [run("a", "succeeded"), run("c", "succeeded")];
    expect(classifyLevelK({ body, rows, scopeRunId: "scope", nodeId: "c", leafStatus: "succeeded" })).toEqual({ ok: true });
  });
});
