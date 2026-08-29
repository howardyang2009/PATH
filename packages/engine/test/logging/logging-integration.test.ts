import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowFile } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogBackends } from "../../src/logging/backends.js";
import type { LogBackend } from "../../src/logging/log-backend.js";
import { LogEventSchema } from "@path/schema";
import { getLogEventsForRoot } from "../../src/logging/db-backend.js";
import { createLoggingObserver } from "../../src/logging/logging-observer.js";
import { openDb } from "../../src/persistence/db.js";
import { dbFilePath, rootRunTreeDir, runBlobDir } from "../../src/persistence/paths.js";
import { createPersistedObserver } from "../../src/persistence/persisted-observer.js";
import { getRunsForRoot } from "../../src/persistence/run-store.js";
import { composeObservers, type RunObserver } from "../../src/run-observer.js";
import { runWorkflow } from "../../src/run-workflow.js";
import { stampNames } from "../stamp-names.js";

// These drive `runWorkflow` end to end against a real sqlite db and blob tree; the cancellation cases
// also wait on an abort to propagate. On a loaded CI runner that can exceed the default 5s vitest
// `testTimeout`, tripping unrelated PRs (#220). 30s gives headroom without masking a real hang.
vi.setConfig({ testTimeout: 30_000 });

let projectDir: string;
let db: Database.Database;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-logging-integration-test-"));
  db = openDb(dbFilePath(projectDir));
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

const twoStepWorkflow: WorkflowFile = {
  format: "path/workflow@3",
  id: "wf-id",
  name: "two-step",
  body: [
    { type: "binary", id: "first", name: "first", command: "node", args: ["-e", "process.stdout.write('a')"] },
    { type: "binary", id: "second", name: "second", command: "node", args: ["-e", "process.stdout.write('b')"] },
  ],
};

function readNdjson(rootRunId: string): unknown[] {
  const path = join(rootRunTreeDir(projectDir, rootRunId), "run.log");
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function rootRunId(): string {
  return (db.prepare("SELECT DISTINCT root_run_id FROM log_events").get() as { root_run_id: string }).root_run_id;
}

describe("logging — end to end through runWorkflow (ticket #19)", () => {
  it("produces the same narrative in the db table and run.log, ordered by seq", async () => {
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const observer = composeObservers(createLoggingObserver(backends));
    const result = await runWorkflow(stampNames(twoStepWorkflow), projectDir, { observer });
    expect(result.status).toBe("succeeded");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileLines = readNdjson(root);

    // run.log opens with the log-header line (acceptance criterion 2); the rest are events.
    expect(fileLines[0]).toEqual({ type: "log-header", format: "path/log@0", run_id: root });
    const fileEvents = fileLines.slice(1);

    // Same narrative, same order (acceptance criterion 1).
    expect(dbEvents).toEqual(fileEvents);
    expect(dbEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dbEvents.map((e) => e.type)).toEqual([
      "step-started", // root workflow-step
      "step-started", // first
      "step-finished", // first
      "step-started", // second
      "step-finished", // second
      "step-finished", // root workflow-step
    ]);
  });

  it("validates every run.log event against the event schema", async () => {
    const backends = createLogBackends(["ndjson"], { db, projectDir });
    await runWorkflow(stampNames(twoStepWorkflow), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });

    const [root] = readdirSync(join(projectDir, ".path", "runs")); // the sole root-run tree
    for (const event of readNdjson(root!).slice(1)) {
      expect(() => LogEventSchema.parse(event)).not.toThrow();
    }
  });

  it("records the failing step's step-finished with its error, then the failed root step-finished", async () => {
    const failing: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "boom",
      body: [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(3)"] }],
    };
    const backends = createLogBackends(["db"], { db, projectDir });
    const result = await runWorkflow(stampNames(failing), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("failed");

    const events = getLogEventsForRoot(db, rootRunId());
    const stepFinished = events.find((e) => e.type === "step-finished" && e.node_id === "boom");
    expect(stepFinished).toMatchObject({ status: "failed", error: expect.stringContaining("exited with code 3") });
    expect(events.at(-1)).toMatchObject({ type: "step-finished", node_id: null, status: "failed" });
  });

  it("fails the run when a backend write fails (audit-first), still writing the run's audit to the survivor", async () => {
    const failing: LogBackend = {
      async open() {},
      async write(event) {
        // Let the run open + start, then fail on the first inner step so the survivor keeps a record.
        if (event.type === "step-started" && event.node_id === "first") throw new Error("backend exploded");
      },
      async close() {},
    };
    const [dbBackend] = createLogBackends(["db"], { db, projectDir });
    const observer = composeObservers(createLoggingObserver([dbBackend!, failing]));
    const result = await runWorkflow(stampNames(twoStepWorkflow), projectDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/backend exploded/);

    // The surviving db backend still holds the narrative up to and including the terminal event.
    const events = getLogEventsForRoot(db, rootRunId());
    expect(events.some((e) => e.type === "step-started" && e.node_id === "first")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "step-finished", node_id: null, status: "failed" });
    // The run did not proceed to the second step after the audit failure.
    expect(events.some((e) => e.node_id === "second")).toBe(false);
  });

  it("narrates a parallel collect join in both backends, with branch ids and published keys (ticket #24)", async () => {
    const parallelWorkflow: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "parallel-join",
      body: [
        {
          type: "parallel",
          id: "fanout", name: "fanout",
          join: "collect",
          branches: [
            { type: "sequence", id: "one", name: "one", body: [{ type: "binary", id: "s1", name: "s1", command: "node", args: ["-e", "process.stdout.write('1')"], publish: { k1: "${output}" } }] },
            { type: "sequence", id: "two", name: "two", body: [{ type: "binary", id: "s2", name: "s2", command: "node", args: ["-e", "process.stdout.write('2')"], publish: { k2: "${output}" } }] },
          ],
        },
      ],
      output: {},
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const result = await runWorkflow(stampNames(parallelWorkflow), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("succeeded");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileEvents = readNdjson(root).slice(1);
    // Both backends carry the identical narrative, and both hold the join-applied event.
    expect(dbEvents).toEqual(fileEvents);
    const join = dbEvents.find((e) => e.type === "join-applied");
    expect(join).toMatchObject({ node_id: "fanout", branches: ["one", "two"], published_keys: ["k1", "k2"] });
  });

  it("narrates a run-cancelled in both backends and marks the cancelled step's row cancelled (ticket #24)", async () => {
    const cancellingWorkflow: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "parallel-cancel",
      body: [
        {
          type: "parallel",
          id: "fanout", name: "fanout",
          join: "collect",
          branches: [
            { type: "sequence", id: "slow", name: "slow", body: [{ type: "binary", id: "sleeper", name: "sleeper", command: "node", args: ["-e", "setTimeout(()=>process.stdout.write('done'),5000)"] }] },
            { type: "sequence", id: "boom", name: "boom", body: [{ type: "binary", id: "kaboom", name: "kaboom", command: "node", args: ["-e", "process.exit(1)"] }] },
          ],
        },
      ],
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const observer = composeObservers(createPersistedObserver(db, projectDir), createLoggingObserver(backends));
    const result = await runWorkflow(stampNames(cancellingWorkflow), projectDir, { observer });
    expect(result.status).toBe("failed");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileEvents = readNdjson(root).slice(1);
    expect(dbEvents).toEqual(fileEvents);

    // The run-cancelled event points at the failing sibling; the sleeper's step-finished is cancelled.
    const cancelled = dbEvents.find((e) => e.type === "run-cancelled");
    expect(cancelled).toMatchObject({ node_id: "sleeper", type: "run-cancelled" });
    expect(dbEvents.some((e) => e.type === "step-finished" && e.node_id === "sleeper" && e.status === "cancelled")).toBe(true);

    // The run row for the cancelled step shows `cancelled` — distinct from the failed root run.
    const rows = getRunsForRoot(db, root);
    expect(rows.find((r) => r.nodeId === "sleeper")?.status).toBe("cancelled");
    expect(rows.find((r) => r.nodeId === "kaboom")?.status).toBe("failed");
  });

  it("ends an externally aborted root run cancelled in both backends, the run rows and context.json (#52)", async () => {
    const cancellableWorkflow: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "operator-cancel",
      body: [
        {
          type: "binary",
          id: "sleeper", name: "sleeper",
          command: "node",
          args: ["-e", "setTimeout(()=>process.stdout.write('done'),5000)"],
          publish: { slow: "${output}" },
        },
      ],
    };
    // Abort from a timer once the step's run has started, so the child is killed in flight.
    const controller = new AbortController();
    const aborter: RunObserver = {
      observe(o) {
        if (o.type === "step-started" && o.nodeId === "sleeper") setTimeout(() => controller.abort(), 0);
      },
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const observer = composeObservers(createPersistedObserver(db, projectDir), createLoggingObserver(backends), aborter);

    const result = await runWorkflow(stampNames(cancellableWorkflow), projectDir, { observer, signal: controller.signal });
    expect(result.status).toBe("cancelled");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileEvents = readNdjson(root).slice(1);
    expect(dbEvents).toEqual(fileEvents); // both backends carry it, and run.log was closed

    // The operator cancellation names its cause and has no cause run behind it.
    expect(dbEvents.find((e) => e.type === "run-cancelled")).toMatchObject({
      node_id: "sleeper",
      cause: "operator",
      cause_run_id: null,
    });
    // The root run's terminal event is a cancelled step-finished on the implicit root step.
    expect(dbEvents.at(-1)).toMatchObject({ type: "step-finished", run_id: root, node_id: null, status: "cancelled" });

    // Both rows land cancelled — no lying `running` row left behind.
    const rows = getRunsForRoot(db, root);
    expect(rows.find((r) => r.runId === root)?.status).toBe("cancelled");
    expect(rows.find((r) => r.nodeId === "sleeper")?.status).toBe("cancelled");

    // A cancelled step lands no publish, so the run's context.json still holds only its input (#24).
    const context = JSON.parse(readFileSync(join(runBlobDir(projectDir, root, root), "context.json"), "utf8"));
    expect(context).toEqual({});
  });

  it("lands no publish from a cancelled step in context.json, wherever the abort arrives (#52)", async () => {
    const publishingStep = (id: string) => ({
      type: "binary" as const,
      id,
      name: id,
      command: "node",
      args: ["-e", `setTimeout(()=>process.stdout.write('${id}'),60)`],
      publish: { [id]: "${output}" },
    });
    const file: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "multi-publish",
      body: [publishingStep("one"), publishingStep("two"), publishingStep("three")],
    };

    // Each pass aborts at a different point of the walk — before the first spawn, mid-step, between
    // steps, after the last. What is asserted is timing-independent: whatever the run rows say
    // happened, `context.json` agrees with them, so a favourable schedule can't make it pass.
    for (const delayMs of [0, 20, 70, 130, 200, 400]) {
      let rootId = "";
      const captureRootId: RunObserver = {
        observe(o) {
          if (o.type === "run-started" && o.parentRunId === null) rootId = o.runId;
        },
      };
      const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
      const observer = composeObservers(createPersistedObserver(db, projectDir), createLoggingObserver(backends), captureRootId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), delayMs);
      const result = await runWorkflow(stampNames(file), projectDir, { observer, signal: controller.signal });
      clearTimeout(timer);

      expect(["cancelled", "succeeded"]).toContain(result.status);
      const rows = getRunsForRoot(db, rootId);
      const succeeded = rows.filter((r) => r.nodeId !== null && r.status === "succeeded").map((r) => r.nodeId);
      const context = JSON.parse(readFileSync(join(runBlobDir(projectDir, rootId, rootId), "context.json"), "utf8"));
      // Exactly the steps that really succeeded published; a cancelled step's key is never there.
      expect(Object.keys(context).sort()).toEqual([...succeeded].sort());
      // And nothing is left mid-flight in the record after the abort settles.
      expect(rows.filter((r) => r.status === "running")).toEqual([]);
    }
  });

  it("selects backends by the log.backends setting — 'none' produces no audit stream", async () => {
    const backends = createLogBackends([], { db, projectDir });
    const result = await runWorkflow(stampNames(twoStepWorkflow), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("succeeded");

    const rows = db.prepare("SELECT COUNT(*) AS n FROM log_events").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("emits checkpoint and branch control events with complete traces to both backends (ticket #21)", async () => {
    const controls: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "controls",
      body: [
        { type: "binary", id: "seed", name: "seed", command: "node", args: ["-e", "process.stdout.write('x')"], publish: { pick: "b" } },
        { type: "checkpoint", id: "gate", name: "gate", condition: { type: "exists", path: "context.pick" } },
        {
          type: "branch",
          id: "route", name: "route",
          arms: [
            { when: { type: "equals", path: "context.pick", value: "a" }, node: { type: "binary", id: "arm-a", name: "arm-a", command: "node", args: ["-e", "process.stdout.write('a')"] } },
            { when: { type: "equals", path: "context.pick", value: "b" }, node: { type: "binary", id: "arm-b", name: "arm-b", command: "node", args: ["-e", "process.stdout.write('b')"] } },
          ],
        },
      ],
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const result = await runWorkflow(stampNames(controls), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("succeeded");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileEvents = readNdjson(root).slice(1);
    // Same control-node narrative in both backends, ordered by seq.
    expect(dbEvents).toEqual(fileEvents);

    const checkpoint = dbEvents.find((e) => e.type === "checkpoint-passed");
    expect(checkpoint).toMatchObject({ node_id: "gate", trace: { type: "exists", path: "context.pick", outcome: "true" } });

    const branch = dbEvents.find((e) => e.type === "branch-taken");
    expect(branch).toMatchObject({ node_id: "route", arm: 1, trace: { type: "equals", path: "context.pick", outcome: "true" } });

    // Every persisted control event still validates against the event schema.
    for (const event of fileEvents) expect(() => LogEventSchema.parse(event)).not.toThrow();
  });

  it("emits while-do iteration-started and loop-exited control events with traces to both backends (ticket #23)", async () => {
    const loop: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "while-loop",
      body: [
        { type: "binary", id: "seed", name: "seed", command: "node", args: ["-e", "process.stdout.write('0')"], parse: "json", publish: { count: "${output}" } },
        {
          type: "while-do",
          id: "loop", name: "loop",
          condition: { type: "range", path: "context.count", max: 1 },
          max_iterations: 10,
          node: {
            type: "binary",
            id: "inc", name: "inc",
            command: "node",
            args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(String(Number(d)+1)))"],
            parse: "json",
            publish: { count: "${output}" },
          },
        },
      ],
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const result = await runWorkflow(stampNames(loop), projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("succeeded");

    const root = rootRunId();
    const dbEvents = getLogEventsForRoot(db, root);
    const fileEvents = readNdjson(root).slice(1);
    expect(dbEvents).toEqual(fileEvents);

    // count runs 0 -> 1 -> 2; the condition (count <= 1) holds for the first two iterations.
    const iterations = dbEvents.filter((e) => e.type === "iteration-started");
    expect(iterations).toHaveLength(2);
    expect(iterations[0]).toMatchObject({ node_id: "loop", iteration: 1 });
    expect(iterations[1]).toMatchObject({ node_id: "loop", iteration: 2 });

    const exited = dbEvents.find((e) => e.type === "loop-exited");
    expect(exited).toMatchObject({ node_id: "loop", reason: "condition-false", iterations: 2, trace: { type: "range", path: "context.count", outcome: "false" } });

    for (const event of fileEvents) expect(() => LogEventSchema.parse(event)).not.toThrow();
  });
});
