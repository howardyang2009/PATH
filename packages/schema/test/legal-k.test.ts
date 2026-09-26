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

// A person-activity leaf — a plugin type, so it is not in the `WorkflowNode` union; cast as the
// structural tests do. It is node-grain reusable (resume-from-k.md), so it gates the prefix like any step.
const person = (id: string): WorkflowNode => ({ type: "person-activity", id, name: id, description: `do ${id}` }) as unknown as WorkflowNode;

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

  it("#3 in-body — present, but inside a control body, and it names the enclosing controller", () => {
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

describe("classifyLevelK — a person-activity is node-grain reusable (resume-from-k.md)", () => {
  // K = c, preceded by a succeeded person-activity gate. The human decision reuses, so a later K
  // is legal — the operator keeps the earlier gate instead of being re-asked.
  const withGate: WorkflowNode[] = [person("gate"), step("b"), step("c")];

  it("admits a later K whose prefix person-activity succeeded (its decision reuses)", () => {
    const rows = [run("gate", "succeeded"), run("b", "succeeded")];
    expect(classifyLevelK({ body: withGate, rows, scopeRunId: "scope", nodeId: "c", leafStatus: "succeeded" })).toEqual({ ok: true });
  });

  it("#5 prefix-unsucceeded — a prefix person-activity still parked (awaiting) blocks a later K", () => {
    const rows = [run("gate", "awaiting"), run("b", "succeeded")];
    expect(classifyLevelK({ body: withGate, rows, scopeRunId: "scope", nodeId: "c", leafStatus: "succeeded" })).toEqual({
      ok: false,
      reason: "prefix-unsucceeded",
    });
  });

  it("a succeeded person-activity is a legal K locus of its own", () => {
    const rows = [run("gate", "succeeded")];
    expect(classifyLevelK({ body: withGate, rows, scopeRunId: "scope", nodeId: "gate", leafStatus: "succeeded" })).toEqual({ ok: true });
  });
});

describe("classifyLevelK — a skipped prefix path is not a broken one (#5)", () => {
  it("admits a prefix node that never ran under scope (an untaken arm, a zero-iteration loop)", () => {
    // b's row is absent entirely: it was skipped, so it does not gate K at c.
    const rows = [run("a", "succeeded"), run("c", "succeeded")];
    expect(classifyLevelK({ body, rows, scopeRunId: "scope", nodeId: "c", leafStatus: "succeeded" })).toEqual({ ok: true });
  });
});

describe("classifyLevelK — under a goto the prefix is counted across passes (ADR 0054 §6)", () => {
  // K = b in pass 2 (scope "pass-2"); pass 1 ("pass-1") ran the whole body before it.
  const inPass = (scope: string, nodeId: string, status: RunStatus): LegalKLevelRun => ({ parentRunId: scope, nodeId, status });
  const pass2 = [inPass("pass-2", "b", "succeeded")];

  it("admits K when every node an earlier pass ran succeeded, including nodes after K's own index", () => {
    const rows = [inPass("pass-1", "a", "succeeded"), inPass("pass-1", "b", "succeeded"), inPass("pass-1", "c", "succeeded"), ...pass2];
    expect(classifyLevelK({ body, rows, scopeRunId: "pass-2", nodeId: "b", leafStatus: "succeeded", earlierPassRunIds: ["pass-1"] })).toEqual({ ok: true });
  });

  it("refuses K when an earlier pass holds an unsucceeded node, even one after K's index", () => {
    const rows = [inPass("pass-1", "a", "succeeded"), inPass("pass-1", "c", "cancelled"), ...pass2];
    expect(classifyLevelK({ body, rows, scopeRunId: "pass-2", nodeId: "b", leafStatus: "succeeded", earlierPassRunIds: ["pass-1"] })).toEqual({
      ok: false,
      reason: "prefix-unsucceeded",
    });
  });
});

describe("classifyLevelK — a sequence body is transparent (ADR 0064)", () => {
  const seq = (id: string, inner: WorkflowNode[]): WorkflowNode => ({ type: "sequence", id, name: id, body: inner });
  // body: a, design{b, c}, test{d, deep{e}}, f — the serial order is a, b, c, d, e, f.
  const staged: WorkflowNode[] = [step("a"), seq("design", [step("b"), step("c")]), seq("test", [step("d"), seq("deep", [step("e")])]), step("f")];
  const rows = ["a", "b", "c", "d", "e"].map((id) => run(id, "succeeded"));

  it("admits K that is a sequence's child", () => {
    expect(classifyLevelK({ body: staged, rows, scopeRunId: "scope", nodeId: "d", leafStatus: "succeeded" })).toEqual({ ok: true });
  });

  it("admits K inside nested sequences", () => {
    expect(classifyLevelK({ body: staged, rows, scopeRunId: "scope", nodeId: "e", leafStatus: "succeeded" })).toEqual({ ok: true });
  });

  it("#5 counts the prefix in serial order: an earlier sibling in the same sequence gates K", () => {
    const broken = [run("a", "succeeded"), run("b", "succeeded"), run("c", "failed"), run("d", "succeeded")];
    expect(classifyLevelK({ body: staged, rows: broken, scopeRunId: "scope", nodeId: "d", leafStatus: "succeeded" })).toEqual({
      ok: false,
      reason: "prefix-unsucceeded",
    });
  });

  it("#5 does not count a later sibling in K's own sequence", () => {
    const laterFailed = [run("a", "succeeded"), run("b", "succeeded"), run("c", "failed")];
    expect(classifyLevelK({ body: staged, rows: laterFailed, scopeRunId: "scope", nodeId: "b", leafStatus: "succeeded" })).toEqual({ ok: true });
  });

  it("#3 still refuses K inside a sequence inside a loop, naming the loop", () => {
    const looped: WorkflowNode[] = [step("a"), loop("spin", seq("s", [step("inner")]) )];
    expect(classifyLevelK({ body: looped, rows: allSucceeded, scopeRunId: "scope", nodeId: "inner", leafStatus: "succeeded" })).toEqual({
      ok: false,
      reason: "in-body",
      container: "loop",
    });
  });
});
