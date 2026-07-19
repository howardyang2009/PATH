import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowFile } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogBackends } from "../../src/logging/backends.js";
import type { LogBackend } from "../../src/logging/log-backend.js";
import { LogEventSchema } from "../../src/logging/log-event.js";
import { getLogEventsForRoot } from "../../src/logging/log-store.js";
import { createLoggingObserver } from "../../src/logging/logging-observer.js";
import { openDb } from "../../src/persistence/db.js";
import { rootRunTreeDir } from "../../src/persistence/paths.js";
import { composeObservers } from "../../src/run-observer.js";
import { runWorkflow } from "../../src/run-workflow.js";

let projectDir: string;
let db: Database.Database;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-logging-integration-test-"));
  db = openDb(join(projectDir, ".path", "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

const twoStepWorkflow: WorkflowFile = {
  format: "path/workflow@0",
  name: "two-step",
  worker: { type: "engine" },
  body: [
    { type: "binary", id: "first", command: "node", args: ["-e", "process.stdout.write('a')"] },
    { type: "binary", id: "second", command: "node", args: ["-e", "process.stdout.write('b')"] },
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
    const result = await runWorkflow(twoStepWorkflow, projectDir, { observer });
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
    await runWorkflow(twoStepWorkflow, projectDir, { observer: composeObservers(createLoggingObserver(backends)) });

    const [root] = readdirSync(join(projectDir, ".path", "runs")); // the sole root-run tree
    for (const event of readNdjson(root!).slice(1)) {
      expect(() => LogEventSchema.parse(event)).not.toThrow();
    }
  });

  it("records the failing step's step-finished with its error, then the failed root step-finished", async () => {
    const failing: WorkflowFile = {
      format: "path/workflow@0",
      name: "boom",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(3)"] }],
    };
    const backends = createLogBackends(["db"], { db, projectDir });
    const result = await runWorkflow(failing, projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
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
    const result = await runWorkflow(twoStepWorkflow, projectDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/backend exploded/);

    // The surviving db backend still holds the narrative up to and including the terminal event.
    const events = getLogEventsForRoot(db, rootRunId());
    expect(events.some((e) => e.type === "step-started" && e.node_id === "first")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "step-finished", node_id: null, status: "failed" });
    // The run did not proceed to the second step after the audit failure.
    expect(events.some((e) => e.node_id === "second")).toBe(false);
  });

  it("selects backends by the log.backends setting — 'none' produces no audit stream", async () => {
    const backends = createLogBackends([], { db, projectDir });
    const result = await runWorkflow(twoStepWorkflow, projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
    expect(result.status).toBe("succeeded");

    const rows = db.prepare("SELECT COUNT(*) AS n FROM log_events").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("emits checkpoint and branch control events with complete traces to both backends (ticket #21)", async () => {
    const controls: WorkflowFile = {
      format: "path/workflow@0",
      name: "controls",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "seed", command: "node", args: ["-e", "process.stdout.write('x')"], publish: { pick: "b" } },
        { type: "checkpoint", id: "gate", condition: { type: "exists", path: "context.pick" } },
        {
          type: "branch",
          id: "route",
          arms: [
            { when: { type: "equals", path: "context.pick", value: "a" }, body: [{ type: "binary", id: "arm-a", command: "node", args: ["-e", "process.stdout.write('a')"] }] },
            { when: { type: "equals", path: "context.pick", value: "b" }, body: [{ type: "binary", id: "arm-b", command: "node", args: ["-e", "process.stdout.write('b')"] }] },
          ],
        },
      ],
    };
    const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
    const result = await runWorkflow(controls, projectDir, { observer: composeObservers(createLoggingObserver(backends)) });
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
});
