import { join } from "node:path";
import type { JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { StepRequest, WorkerDescriptor } from "../src/plugin/seam.js";
import type { Observation } from "../src/run-observer.js";
import { fakeObserver, type FakeObserver } from "./fake-observer.js";
import { runWorkflow, type ResumeInput } from "../src/run-workflow.js";
import { stampNames } from "./stamp-names.js";

/**
 * Replay from seed (#608, ADR 0062): a re-entered workflow-run starts its context from its seed — the
 * root from its counterpart's recorded `input.json`, a nested run from its own replayed input — and
 * the reused prefix re-publishes in walk order, so every node sees exactly the context it saw
 * originally. The counterpart's final `context.json`
 * is never the starting point: under Resume-from-K it already holds keys written after K.
 *
 * Every original tree here records a final `context.json` that differs from the replayed one, so a
 * restore-by-load engine would fail each assertion.
 */

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "orig-root",
    nodeName: overrides.nodeId,
    workerName: null,
    iteration: null,
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

interface Executed {
  label: string;
  input: JsonValue;
}

function recordingWorker(outputs: { [label: string]: JsonValue }, ran: Executed[]): WorkerDescriptor {
  return {
    meters: false,
    needsProcessorSlot: true,
    run: async (request: StepRequest) => {
      const label = String(request.fields.prompt);
      ran.push({ label, input: request.input });
      return { status: "succeeded", output: outputs[label] ?? `ran-${label}` };
    },
  };
}

function promptOverride(worker: WorkerDescriptor) {
  return { prompt: { anthropic: worker } };
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
  return stampNames({ format: "path/workflow@4", name: "resumed", config: { model: "m" }, body, ...(output ? { output } : {}) });
}

function contextsOf(observer: FakeObserver, runId: string): JsonValue[] {
  return observer
    .all()
    .filter((o): o is Extract<Observation, { type: "context-changed" }> => o.type === "context-changed" && o.runId === runId)
    .map((o) => o.context);
}

function rootRunId(observer: FakeObserver): string {
  const started = observer.all().find((o): o is Extract<Observation, { type: "run-started" }> => o.type === "run-started" && o.parentRunId === null);
  return started!.runId;
}

// Seed y=0. a publishes x; b records the y it sees; c overwrites y. The original's final context
// therefore holds y="5" — a key b must not see when it re-runs.
const xyFile = () =>
  tree(
    [
      { type: "prompt", id: "a", name: "a", prompt: "a", publish: { x: "${output}" } },
      { type: "prompt", id: "b", name: "b", prompt: "b", publish: { seenByB: "${context.y}" } },
      { type: "prompt", id: "c", name: "c", prompt: "c", publish: { y: "${output}" } },
    ],
    { seen: "${context.seenByB}", x: "${context.x}" },
  );

const xyOriginalRuns = (rootStatus: RunRecord["status"], cStatus: RunRecord["status"]): RunRecord[] => [
  run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: rootStatus }),
  run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", status: "succeeded" }),
  run({ runId: "b-run", parentRunId: "orig-root", nodeId: "b", status: "succeeded" }),
  run({ runId: "c-run", parentRunId: "orig-root", nodeId: "c", status: cStatus }),
];

describe("replay from seed — straight-line file", () => {
  it("Resume-from-K: K sees the seed value, not the one a later node wrote (the y=0 / y=5 case)", async () => {
    const ran: Executed[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(xyFile(), "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({ c: "5" }, ran)),
      resume: {
        originalRuns: xyOriginalRuns("succeeded", "succeeded"),
        readBlob: reader(
          {
            "orig-root/input.json": { y: 0 },
            "orig-root/context.json": { y: "5", x: "1", seenByB: 0 },
            "a-run/output.json": "1",
          },
          reads,
        ),
        rerunFromNodePath: ["b"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran.map((r) => r.label)).toEqual(["b", "c"]);
    expect(result.output).toEqual({ seen: 0, x: "1" });
    expect(reads).toContain("orig-root/input.json");
    expect(reads).not.toContain("orig-root/context.json");
  });

  it("plain Resume ends on the same context the original would have reached", async () => {
    const ran: Executed[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(xyFile(), "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({ c: "5" }, ran)),
      resume: {
        // The original failed at c: a and b reuse and re-publish over the seed, c re-runs.
        originalRuns: xyOriginalRuns("failed", "failed"),
        readBlob: reader(
          {
            "orig-root/input.json": { y: 0 },
            "orig-root/context.json": { y: 0, x: "1", seenByB: 0 },
            "a-run/output.json": "1",
            "b-run/output.json": "ran-b",
          },
          [],
        ),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran.map((r) => r.label)).toEqual(["c"]);
    expect(result.output).toEqual({ seen: 0, x: "1" });
    expect(contextsOf(observer, rootRunId(observer)).at(-1)).toEqual({ y: "5", x: "1", seenByB: 0 });
  });
});

describe("replay from seed — while-do", () => {
  it("a re-run loop evaluates its condition against the seed, not against keys its own past iterations wrote", async () => {
    // [a, loop { body }]: the loop runs while `done` is absent; its body publishes `done`. The
    // original's final context holds `done`, so a restore-by-load engine would skip the loop entirely.
    const file = tree(
      [
        { type: "prompt", id: "a", name: "a", prompt: "a", publish: { fromA: "${output}" } },
        {
          type: "while-do",
          id: "loop",
          name: "loop",
          condition: { type: "not", of: { type: "exists", path: "context.done" } },
          max_iterations: 3,
          node: { type: "prompt", id: "body", name: "body", prompt: "body", publish: { done: "${output}" } },
        },
      ],
      { done: "${context.done}" },
    );
    const ran: Executed[] = [];

    const result = await runWorkflow(file, "/tmp", {
      observer: fakeObserver(),
      workerOverrides: promptOverride(recordingWorker({ body: "FRESH" }, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", status: "succeeded" }),
          run({ runId: "iter-1", parentRunId: "orig-root", nodeId: "loop", iteration: 1, status: "succeeded" }),
          run({ runId: "body-1", parentRunId: "iter-1", nodeId: "body", status: "succeeded" }),
        ],
        readBlob: reader(
          {
            "orig-root/input.json": {},
            "orig-root/context.json": { fromA: "A", done: "OLD" },
            "a-run/output.json": "A",
          },
          [],
        ),
        rerunFromNodePath: ["loop"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran.map((r) => r.label)).toEqual(["body"]);
    expect(result.output).toEqual({ done: "FRESH" });
  });

  it("a reused loop replays each iteration's publish in order, so a node after it sees the last iteration's value", async () => {
    // Seed n="0". [loop { body }, after, late]: two reused iterations publish n=1 then n=2; `after`
    // (K) records n; `late` overwrites n, so the original's final context holds n="LATE".
    const file = tree(
      [
        {
          type: "while-do",
          id: "loop",
          name: "loop",
          condition: { type: "not", of: { type: "equals", path: "context.n", value: "2" } },
          max_iterations: 3,
          node: { type: "prompt", id: "body", name: "body", prompt: "body", publish: { n: "${output}" } },
        },
        { type: "prompt", id: "after", name: "after", prompt: "after", publish: { seenN: "${context.n}" } },
        { type: "prompt", id: "late", name: "late", prompt: "late", publish: { n: "${output}" } },
      ],
      { seenN: "${context.seenN}" },
    );
    const ran: Executed[] = [];

    const result = await runWorkflow(file, "/tmp", {
      observer: fakeObserver(),
      workerOverrides: promptOverride(recordingWorker({ late: "LATE" }, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "iter-1", parentRunId: "orig-root", nodeId: "loop", iteration: 1, status: "succeeded" }),
          run({ runId: "body-1", parentRunId: "iter-1", nodeId: "body", status: "succeeded" }),
          run({ runId: "iter-2", parentRunId: "orig-root", nodeId: "loop", iteration: 2, status: "succeeded" }),
          run({ runId: "body-2", parentRunId: "iter-2", nodeId: "body", status: "succeeded" }),
          run({ runId: "after-run", parentRunId: "orig-root", nodeId: "after", status: "succeeded" }),
          run({ runId: "late-run", parentRunId: "orig-root", nodeId: "late", status: "succeeded" }),
        ],
        readBlob: reader(
          {
            "orig-root/input.json": { n: "0" },
            "orig-root/context.json": { n: "LATE", seenN: "2" },
            "body-1/output.json": "1",
            "body-2/output.json": "2",
          },
          [],
        ),
        rerunFromNodePath: ["after"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran.map((r) => r.label)).toEqual(["after", "late"]);
    expect(result.output).toEqual({ seenN: "2" });
  });
});

describe("replay from seed — nested workflow step", () => {
  it("a descended child seeds from its own input, so its K does not see its own later writes", async () => {
    // Root [sub → nested [p, k, q]]. The child's seed is v="orig"; q overwrites v. K = k inside sub.
    const nestedPath = join("/tmp", "nested.workflow.json");
    const nested = tree(
      [
        { type: "prompt", id: "p", name: "p", prompt: "p", publish: { fromP: "${output}" } },
        { type: "prompt", id: "k", name: "k", prompt: "k", publish: { seenV: "${context.v}" } },
        { type: "prompt", id: "q", name: "q", prompt: "q", publish: { v: "${output}" } },
      ],
      { seenV: "${context.seenV}" },
    );
    const file = tree(
      [{ type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: { v: "orig" }, publish: { sub: "${output}" } }],
      { sub: "${context.sub}" },
    );
    const ran: Executed[] = [];
    const reads: string[] = [];

    const result = await runWorkflow(file, "/tmp", {
      observer: fakeObserver(),
      files: new Map([[nestedPath, nested]]),
      workerOverrides: promptOverride(recordingWorker({ q: "late" }, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", status: "succeeded" }),
          run({ runId: "p-run", parentRunId: "sub-run", nodeId: "p", status: "succeeded" }),
          run({ runId: "k-run", parentRunId: "sub-run", nodeId: "k", status: "succeeded" }),
          run({ runId: "q-run", parentRunId: "sub-run", nodeId: "q", status: "succeeded" }),
        ],
        readBlob: reader(
          {
            "orig-root/input.json": {},
            "orig-root/context.json": { sub: { seenV: "orig" } },
            "sub-run/context.json": { v: "late", fromP: "P", seenV: "orig" },
            "p-run/output.json": "P",
          },
          reads,
        ),
        rerunFromNodePath: ["sub", "k"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran.map((r) => r.label)).toEqual(["k", "q"]);
    expect(result.output).toEqual({ sub: { seenV: "orig" } });
    // The child's seed is its own replayed input; neither of its recorded context blobs is read.
    expect(reads.some((key) => key.startsWith("sub-run/"))).toBe(false);
  });
});

describe("replay from seed — parallel joins", () => {
  it("a reused collect join re-lands every branch's buffered publish before the node after it", async () => {
    const file = tree(
      [
        {
          type: "parallel",
          id: "fan",
          name: "fan",
          join: "collect",
          branches: [
            { type: "sequence", id: "left", name: "left", body: [{ type: "prompt", id: "l", name: "l", prompt: "l", publish: { fromL: "${output}" } }] },
            { type: "sequence", id: "right", name: "right", body: [{ type: "prompt", id: "r", name: "r", prompt: "r", publish: { fromR: "${output}" } }] },
          ],
        },
        { type: "prompt", id: "after", name: "after", prompt: "after", publish: { both: ["${context.fromL}", "${context.fromR}"] } },
      ],
      { both: "${context.both}" },
    );
    const observer = fakeObserver();

    const result = await runWorkflow(file, "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({}, [])),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "l-run", parentRunId: "orig-root", nodeId: "l", status: "succeeded" }),
          run({ runId: "r-run", parentRunId: "orig-root", nodeId: "r", status: "succeeded" }),
          run({ runId: "after-run", parentRunId: "orig-root", nodeId: "after", status: "succeeded" }),
        ],
        readBlob: reader(
          { "orig-root/input.json": {}, "orig-root/context.json": {}, "l-run/output.json": "L", "r-run/output.json": "R" },
          [],
        ),
        rerunFromNodePath: ["after"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ both: ["L", "R"] });
    // Landed at the join in branch declaration order, exactly as the original join did.
    expect(observer.all().find((o) => o.type === "join-applied")).toMatchObject({ nodeId: "fan", publishedKeys: ["fromL", "fromR"] });
  });

  it("a reused wait-one join re-lands only the recorded winner's publish", async () => {
    const file = tree(
      [
        {
          type: "parallel",
          id: "race",
          name: "race",
          join: "wait-one",
          branches: [
            { type: "sequence", id: "fast", name: "fast", body: [{ type: "prompt", id: "f", name: "f", prompt: "f", publish: { fromF: "${output}" } }] },
            { type: "sequence", id: "slow", name: "slow", body: [{ type: "prompt", id: "s", name: "s", prompt: "s", publish: { fromS: "${output}" } }] },
          ],
        },
        { type: "prompt", id: "after", name: "after", prompt: "after" },
      ],
    );
    const observer = fakeObserver();

    const result = await runWorkflow(file, "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({}, [])),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "f-run", parentRunId: "orig-root", nodeId: "f", status: "succeeded" }),
          run({ runId: "s-run", parentRunId: "orig-root", nodeId: "s", status: "cancelled" }),
          run({ runId: "after-run", parentRunId: "orig-root", nodeId: "after", status: "succeeded" }),
        ],
        readBlob: reader({ "orig-root/input.json": {}, "orig-root/context.json": { fromF: "F" }, "f-run/output.json": "F" }, []),
        rerunFromNodePath: ["after"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(contextsOf(observer, rootRunId(observer)).at(-1)).toEqual({ fromF: "F" });
  });
});

describe("replay from seed — secrets", () => {
  it("a replayed publish of a secret config value yields the real value, not its mask token", async () => {
    // a publishes the secret; b (K) takes it as input. The recorded context holds the mask token.
    const file = tree([
      { type: "prompt", id: "a", name: "a", prompt: "a", publish: { token: "${config.apiKey}" } },
      { type: "prompt", id: "b", name: "b", prompt: "b", input: { token: "${context.token}" } },
    ]);
    const ran: Executed[] = [];

    const result = await runWorkflow(file, "/tmp", {
      observer: fakeObserver(),
      operatorConfig: { apiKey: { $secret: "sk-real" } },
      workerOverrides: promptOverride(recordingWorker({}, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", status: "succeeded" }),
          run({ runId: "b-run", parentRunId: "orig-root", nodeId: "b", status: "succeeded" }),
        ],
        readBlob: reader(
          { "orig-root/input.json": {}, "orig-root/context.json": { token: "[secret:apiKey]" }, "a-run/output.json": "A" },
          [],
        ),
        rerunFromNodePath: ["b"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual([{ label: "b", input: { token: "sk-real" } }]);
  });
});

describe("replay from seed — the successor records its seed", () => {
  it("a resumed root's run-started records the recorded seed, so a Resume of the successor replays from it too", async () => {
    const observer = fakeObserver();

    await runWorkflow(xyFile(), "/tmp", {
      observer,
      workerOverrides: promptOverride(recordingWorker({ c: "5" }, [])),
      resume: {
        originalRuns: xyOriginalRuns("succeeded", "succeeded"),
        readBlob: reader({ "orig-root/input.json": { y: 0 }, "a-run/output.json": "1" }, []),
        rerunFromNodePath: ["b"],
      },
    });

    const rootStarted = observer
      .all()
      .find((o): o is Extract<Observation, { type: "run-started" }> => o.type === "run-started" && o.parentRunId === null);
    expect(rootStarted!.input).toEqual({ y: 0 });
  });
});

describe("replay from seed — secrets in a nested seed", () => {
  it("a descended child seeds from its freshly interpolated input, so a secret in it is real, not the recorded mask token", async () => {
    const nestedPath = join("/tmp", "nested.workflow.json");
    const nested = tree([
      { type: "prompt", id: "p", name: "p", prompt: "p" },
      { type: "prompt", id: "k", name: "k", prompt: "k", input: { token: "${context.token}" } },
    ]);
    const file = tree([
      { type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json", input: { token: "${config.apiKey}" } },
    ]);
    const ran: Executed[] = [];

    const result = await runWorkflow(file, "/tmp", {
      observer: fakeObserver(),
      files: new Map([[nestedPath, nested]]),
      operatorConfig: { apiKey: { $secret: "sk-real" } },
      workerOverrides: promptOverride(recordingWorker({}, ran)),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded" }),
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", status: "succeeded" }),
          run({ runId: "p-run", parentRunId: "sub-run", nodeId: "p", status: "succeeded" }),
          run({ runId: "k-run", parentRunId: "sub-run", nodeId: "k", status: "succeeded" }),
        ],
        readBlob: reader(
          // A read of the child's masked seed would throw: it is not supplied.
          { "orig-root/input.json": {}, "p-run/output.json": "P" },
          [],
        ),
        rerunFromNodePath: ["sub", "k"],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual([{ label: "k", input: { token: "sk-real" } }]);
  });
});
