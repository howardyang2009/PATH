import type { WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { childIdentity, openContainerRun } from "../src/child-run.js";
import { createProcessorSemaphore } from "../src/processor-semaphore.js";
import type { RunContext, RunIdentity } from "../src/run-context.js";
import { createEmitter } from "../src/run-emitter.js";
import type { Observation } from "../src/run-observer.js";

const parentIdentity: RunIdentity = {
  runId: "parent",
  rootRunId: "root",
  parentRunId: "root",
  nodeId: "n",
  nodeName: "n",
};
const file: WorkflowFile = { format: "path/workflow@5", id: "wf", name: "wf", body: [] };
const loop = { id: "loop-id", name: "loop" };

function parentRun(into: Observation[]): RunContext {
  return {
    file,
    fileDir: "/tmp",
    fileConfig: {},
    identity: parentIdentity,
    emitter: createEmitter(parentIdentity, async (o) => {
      into.push(o);
    }),
    env: {},
    runtime: { registry: {}, semaphore: createProcessorSemaphore(1) },
    detached: [],
  };
}

describe("childIdentity", () => {
  it("mints a fresh id under the parent, owned by the node", () => {
    const identity = childIdentity(parentIdentity, { owner: loop, iteration: 2 });
    expect(identity).toMatchObject({
      rootRunId: "root",
      parentRunId: "parent",
      nodeId: "loop-id",
      nodeName: "loop",
      iteration: 2,
    });
    expect(identity.runId).not.toBe(childIdentity(parentIdentity, { owner: loop }).runId);
  });

  it("re-enters a recorded row in place (ADR 0041)", () => {
    expect(childIdentity(parentIdentity, { owner: null, pass: 1 }, "recorded").runId).toBe(
      "recorded",
    );
    expect(childIdentity(parentIdentity, { owner: null, pass: 1 }, "recorded")).toMatchObject({
      nodeId: null,
      nodeName: null,
      pass: 1,
    });
  });
});

describe("openContainerRun", () => {
  it("starts a fresh container with its input and closes it on finish", async () => {
    const observed: Observation[] = [];
    const container = await openContainerRun(parentRun(observed), {
      key: { owner: loop, iteration: 1 },
      existingRunId: undefined,
      input: { seed: 1 },
      resume: undefined,
    });
    expect(container.started).toBe(true);
    expect(container.run.identity.parentRunId).toBe("parent");
    await container.finish({ status: "succeeded", output: "done" });
    expect(observed.map((o) => o.type)).toEqual(["run-started", "run-finished"]);
    expect(observed[0]).toMatchObject({
      runId: container.run.identity.runId,
      input: { seed: 1 },
      iteration: 1,
    });
  });

  it("re-enters a running container without a second run-started", async () => {
    const observed: Observation[] = [];
    const container = await openContainerRun(parentRun(observed), {
      key: { owner: null, pass: 3 },
      existingRunId: "running-pass",
      input: null,
      resume: undefined,
    });
    expect(container.started).toBe(false);
    expect(container.run.identity.runId).toBe("running-pass");
    expect(observed).toEqual([]);
  });

  it("swaps only identity, emitter and resume into the parent's context", async () => {
    const parent = parentRun([]);
    const container = await openContainerRun(parent, {
      key: { owner: loop, iteration: 1 },
      existingRunId: undefined,
      input: null,
      resume: undefined,
    });
    expect(container.run.file).toBe(parent.file);
    expect(container.run.runtime).toBe(parent.runtime);
    expect(container.run.detached).toBe(parent.detached);
    expect(container.run.emitter).not.toBe(parent.emitter);
  });
});
