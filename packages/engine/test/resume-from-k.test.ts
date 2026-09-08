import { join } from "node:path";
import type { JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { StepRequest, WorkerDescriptor } from "../src/plugin/seam.js";
import type { Observation } from "../src/run-observer.js";
import { fakeObserver, type FakeObserver } from "./fake-observer.js";
import { runWorkflow, type ResumeInput } from "../src/run-workflow.js";
import { stampNames } from "./stamp-names.js";

/**
 * Resume-from-chosen-K, the engine mechanism (spec §4, ADR 0035): a rerun boundary K expressed as a
 * root-only suppression set on the two reuse producers. Nodes before K reuse bit-for-bit; K and every
 * serialized-later top-level node re-run, a ≥K `workflow` node's whole subtree entire. Plain Resume is
 * the K-omitted case of the one path — the superset invariant this suite anchors.
 *
 * The harness mirrors resume.test.ts: an in-memory original tree of `RunRecord`s plus a blob reader,
 * with a scripted worker recording which nodes actually executed.
 */

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "orig-root",
    nodeName: overrides.nodeId,
    workerName: null,
    startedAt: "t0",
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    rerunFromNodePath: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...overrides,
  };
}

function nodeLabel(request: StepRequest): string {
  return String(request.fields.prompt);
}

function recordingWorker(outputs: { [nodeName: string]: string }, ran: string[]): WorkerDescriptor {
  return {
    meters: false,
    needsProcessorSlot: true,
    run: async (request) => {
      const label = nodeLabel(request);
      ran.push(label);
      return { status: "succeeded", output: outputs[label] ?? `ran-${label}` };
    },
  };
}

function promptOverride(worker: WorkerDescriptor) {
  return { prompt: { sdk: worker } };
}

function reader(blobs: { [key: string]: JsonValue }, reads: string[]): ResumeInput["readBlob"] {
  return (record, filename) => {
    const key = `${record.runId}/${filename}`;
    reads.push(key);
    if (!(key in blobs)) throw new Error(`no such original blob: ${key}`);
    return blobs[key]!;
  };
}

function tree(body: WorkflowFile["body"], output?: WorkflowFile["output"]): WorkflowFile {
  return stampNames({ format: "path/workflow@3", name: "resumed", config: { model: "m" }, body, ...(output ? { output } : {}) });
}

function markers(observer: FakeObserver): Extract<Observation, { type: "reuse-marker" }>[] {
  return observer.all().filter((o): o is Extract<Observation, { type: "reuse-marker" }> => o.type === "reuse-marker");
}

// A three-node all-succeeded original tree over top-level prompts a, b, c.
const abc = () =>
  tree(
    [
      { type: "prompt", id: "a", name: "a", prompt: "a", publish: { fromA: "${output}" } },
      { type: "prompt", id: "b", name: "b", prompt: "b", publish: { fromB: "${output}" } },
      { type: "prompt", id: "c", name: "c", prompt: "c", publish: { fromC: "${output}" } },
    ],
    { a: "${context.fromA}", b: "${context.fromB}", c: "${context.fromC}" },
  );

const abcOriginalRuns = (): RunRecord[] => [
  run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
  run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
  run({ runId: "b-run", parentRunId: "orig-root", nodeId: "b", nodeName: "b", status: "succeeded" }),
  run({ runId: "c-run", parentRunId: "orig-root", nodeId: "c", nodeName: "c", status: "succeeded" }),
];

describe("Resume-from-K — top-level boundary (ADR 0035)", () => {
  it("reuses <K and re-runs K and every serialized-later node", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(abc(), "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({ b: "FRESH_B", c: "FRESH_C" }, ran)),
      resume: {
        originalRuns: abcOriginalRuns(),
        readBlob: reader({ "orig-root/context.json": {}, "a-run/output.json": "REUSED_A" }, reads),
        // K = b: a is <K and reuses; b and c are ≥K and re-run.
        rerunFromNodePath: ["b"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual(["b", "c"]);
    expect(result.output).toEqual({ a: "REUSED_A", b: "FRESH_B", c: "FRESH_C" });
    // Only the <K prefix reused, one marker for a.
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["a"]);
  });

  it("re-runs a ≥K workflow node's whole subtree entire (no reuse inside it)", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const nestedPath = join("/tmp", "nested.workflow.json");
    const nested = tree([{ type: "prompt", id: "inner", name: "inner", prompt: "inner", publish: { r: "${output}" } }], {
      r: "${context.r}",
    });
    const file = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a", publish: { fromA: "${output}" } },
      // A workflow node needs a JSON-object input to seed the child context (format §6.3).
      { type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: { seed: "${context.fromA}" } },
    ]);

    const result = await runWorkflow(file, "/tmp", {
      observer,
      files: new Map([[nestedPath, nested]]),
      workerOverrides: promptOverride(recordingWorker({ inner: "FRESH_INNER" }, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", nodeName: "sub", status: "succeeded" }),
          run({ runId: "inner-run", parentRunId: "sub-run", nodeId: "inner", nodeName: "inner", status: "succeeded" }),
        ],
        readBlob: reader({ "orig-root/context.json": {}, "a-run/output.json": "REUSED_A" }, reads),
        // K = sub (a ≥K workflow node): its whole subtree re-runs, inner included.
        rerunFromNodePath: ["sub"],
      },
    });

    expect(result.status).toBe("succeeded");
    // inner re-executed (subtree entire); a still reused as the <K prefix.
    expect(ran).toEqual(["inner"]);
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["a"]);
    // The collapsed subtree's original blob was never read — sub re-ran fresh, it did not reuse.
    expect(reads.some((key) => key.startsWith("sub-run/") || key.startsWith("inner-run/"))).toBe(false);
  });
});

describe("Resume-from-K — the superset invariant (spec §4)", () => {
  it("an empty path is plain Resume byte-for-byte", async () => {
    async function once(rerunFromNodePath: string[] | undefined): Promise<{ ran: string[]; markers: (string | null)[]; output: JsonValue }> {
      const ran: string[] = [];
      const reads: string[] = [];
      const observer = fakeObserver();
      // Original root failed at c (a, b done); plain Resume reuses a and b, re-runs c.
      const result = await runWorkflow(abc(), "/tmp", {
        observer,
        workerOverrides: promptOverride(recordingWorker({ c: "FRESH_C" }, ran)),
        resume: {
          originalRuns: [
            run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
            run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
            run({ runId: "b-run", parentRunId: "orig-root", nodeId: "b", nodeName: "b", status: "succeeded" }),
            run({ runId: "c-run", parentRunId: "orig-root", nodeId: "c", nodeName: "c", status: "failed" }),
          ],
          readBlob: reader(
            { "orig-root/context.json": {}, "a-run/output.json": "REUSED_A", "b-run/output.json": "REUSED_B" },
            reads,
          ),
          rerunFromNodePath,
        },
      });
      return { ran, markers: markers(observer).map((m) => m.nodeId), output: result.output };
    }

    // K at the auto-boundary (first non-succeeded top-level node, c) ≡ plain Resume (undefined path).
    const plain = await once(undefined);
    const kAtAuto = await once(["c"]);
    expect(kAtAuto).toEqual(plain);
    expect(plain.ran).toEqual(["c"]);
    expect(plain.markers).toEqual(["a", "b"]);
  });
});

// Root [a, sub→nested, d]; nested [p, k, q]. A nested K inside `sub` reached by the path [sub, k].
const NESTED_PATH = join("/tmp", "nested.workflow.json");
const nestedPkq = () =>
  tree([
    { type: "prompt", id: "p", name: "p", prompt: "p", publish: { fromP: "${output}" } },
    { type: "prompt", id: "k", name: "k", prompt: "k", publish: { fromK: "${output}" } },
    { type: "prompt", id: "q", name: "q", prompt: "q", publish: { fromQ: "${output}" } },
  ]);
const rootAsubD = () =>
  tree([
    { type: "prompt", id: "a", name: "a", prompt: "a", publish: { fromA: "${output}" } },
    { type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: { seed: "${context.fromA}" } },
    { type: "prompt", id: "d", name: "d", prompt: "d", publish: { fromD: "${output}" } },
  ]);
const asubdOriginalRuns = (): RunRecord[] => [
  run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
  run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
  run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", nodeName: "sub", status: "succeeded" }),
  run({ runId: "p-run", parentRunId: "sub-run", nodeId: "p", nodeName: "p", status: "succeeded" }),
  run({ runId: "k-run", parentRunId: "sub-run", nodeId: "k", nodeName: "k", status: "succeeded" }),
  run({ runId: "q-run", parentRunId: "sub-run", nodeId: "q", nodeName: "q", status: "succeeded" }),
  run({ runId: "d-run", parentRunId: "orig-root", nodeId: "d", nodeName: "d", status: "succeeded" }),
];

describe("Resume-from-K — nested boundary (ADR 0036)", () => {
  it("descends into the containing workflow: reuses the inner prefix, re-runs from K, cascades up", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(rootAsubD(), "/tmp", {
      observer,
      files: new Map([[NESTED_PATH, nestedPkq()]]),
      workerOverrides: promptOverride(recordingWorker({ k: "FRESH_K", q: "FRESH_Q", d: "FRESH_D" }, ran)),
      resume: {
        originalRuns: asubdOriginalRuns(),
        readBlob: reader(
          {
            "orig-root/context.json": {},
            "a-run/output.json": "REUSED_A",
            "sub-run/context.json": {},
            "p-run/output.json": "REUSED_P",
          },
          reads,
        ),
        // K = k inside sub: a reuses (<sub at root); sub descends; p reuses (<k inside sub); k and q
        // re-run (k == K, q after K); d re-runs (after sub at root, cascade-up).
        rerunFromNodePath: ["sub", "k"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual(["k", "q", "d"]);
    // Partial reuse inside the descended child: the inner prefix p reused, one marker per reused node.
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["a", "p"]);
    // The inner prefix's blob was read (it reused); K's and Q's originals were not (they re-ran).
    expect(reads).toContain("p-run/output.json");
    expect(reads.some((key) => key.startsWith("k-run/") || key.startsWith("q-run/"))).toBe(false);
  });

  it("splits an intermediate level: the path-node descends, an after-B sibling workflow re-runs entire", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const sub2Path = join("/tmp", "sub2.workflow.json");
    // Root [sub→[p,k], sub2→[p2]]; K = k inside sub. sub descends (reuses p); sub2 is after sub, so it
    // re-runs entire — its own succeeded prefix p2 is *not* reused.
    const nestedPk = tree([
      { type: "prompt", id: "p", name: "p", prompt: "p", publish: { fromP: "${output}" } },
      { type: "prompt", id: "k", name: "k", prompt: "k", publish: { fromK: "${output}" } },
    ]);
    const nestedP2 = tree([{ type: "prompt", id: "p2", name: "p2", prompt: "p2", publish: { fromP2: "${output}" } }]);
    const rootTwoSubs = tree([
      { type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: {} },
      { type: "workflow", id: "sub2", name: "sub2", ref: "./sub2.workflow.json", input: {} },
    ]);

    const result = await runWorkflow(rootTwoSubs, "/tmp", {
      observer,
      files: new Map([
        [NESTED_PATH, nestedPk],
        [sub2Path, nestedP2],
      ]),
      workerOverrides: promptOverride(recordingWorker({ k: "FRESH_K", p2: "FRESH_P2" }, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", nodeName: "sub", status: "succeeded" }),
          run({ runId: "p-run", parentRunId: "sub-run", nodeId: "p", nodeName: "p", status: "succeeded" }),
          run({ runId: "k-run", parentRunId: "sub-run", nodeId: "k", nodeName: "k", status: "succeeded" }),
          run({ runId: "sub2-run", parentRunId: "orig-root", nodeId: "sub2", nodeName: "sub2", status: "succeeded" }),
          run({ runId: "p2-run", parentRunId: "sub2-run", nodeId: "p2", nodeName: "p2", status: "succeeded" }),
        ],
        readBlob: reader(
          { "orig-root/context.json": {}, "sub-run/context.json": {}, "p-run/output.json": "REUSED_P" },
          reads,
        ),
        rerunFromNodePath: ["sub", "k"],
      },
    });

    expect(result.status).toBe("succeeded");
    // sub descended → p reused, k re-ran; sub2 re-ran entire → p2 re-ran fresh (no reuse inside it).
    expect(ran).toEqual(["k", "p2"]);
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["p"]);
    // The after-B subtree was forced fresh: its collapsed original blob was never read.
    expect(reads.some((key) => key.startsWith("sub2-run/") || key.startsWith("p2-run/"))).toBe(false);
  });
});
