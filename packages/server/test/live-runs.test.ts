import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowTree, openProject, type Project } from "@path/engine";
import type { LogEvent } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveRuns, type LiveRuns, type StartedRun } from "../src/live-runs.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * `LiveRuns` is what `POST /v0/runs`, `POST .../cancel` and `GET .../events` are made of, and none
 * of it needs a port: these drive it directly. Before it existed, the controller registry's
 * lifecycle was not observable through the HTTP surface at all — once a run is terminal the cancel
 * route refuses on terminality before it ever consults the registry — so its tests drove a route
 * handler with a hand-built request and response.
 */
let projectDir: string;
let project: Project;
let live: LiveRuns;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-live-runs-test-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  project = opened.project;
  live = createLiveRuns(project);
});

afterEach(() => {
  project.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function startFixture(filename: string, runs = live): Promise<StartedRun> {
  const loaded = loadWorkflowTree(join(projectDir, filename));
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const { tree } = loaded;
  return runs.start(tree.files.get(tree.rootPath)!, dirname(tree.rootPath), { files: tree.files });
}

/** Waits for the root row to reach a terminal status, then lets the run promise's settle handler run. */
async function awaitSettled(rootRunId: string): Promise<string> {
  for (;;) {
    const root = project.archive.tree(rootRunId)?.root;
    if (root && root.status !== "pending" && root.status !== "running") {
      // The row is written by the `runFinished` observer, which fires *before* `runWorkflow`'s
      // promise settles — give the `.then` that drops the controller its turn.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
      return root.status;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("LiveRuns — start resolves on run-started, not on finish", () => {
  it("answers ids while the run is still executing, and the run is already queryable", async () => {
    const { runId, rootRunId } = await startFixture("slow-step.workflow.json");

    expect(runId).toBe(rootRunId);
    // The guarantee behind the 202: the row exists by the time `start` resolves.
    expect(project.archive.tree(rootRunId)?.root?.status).toBe("running");

    expect(await awaitSettled(rootRunId)).toBe("succeeded");
  });

  it("rejects when the run never starts, rather than hanging forever", async () => {
    const crashing: Project = {
      ...project,
      run: () => Promise.reject(new Error("engine bug")),
    };

    await expect(startFixture("slow-step.workflow.json", createLiveRuns(crashing))).rejects.toThrow("engine bug");
  });
});

describe("LiveRuns — cancellable while executing, and only while executing", () => {
  it("holds the run while it executes and drops it once it succeeds", async () => {
    const { rootRunId } = await startFixture("slow-step.workflow.json");
    // Cancellable under the id the caller was just handed — which is what makes it cancellable.
    expect(live.cancellable).toBe(1);
    expect(live.cancel("no-such-run")).toBe(false);

    expect(await awaitSettled(rootRunId)).toBe("succeeded");
    expect(live.cancellable).toBe(0);
  });

  it("drops the run when it fails, not only when it succeeds", async () => {
    const { rootRunId } = await startFixture("failing-step.workflow.json");

    expect(await awaitSettled(rootRunId)).toBe("failed");
    expect(live.cancellable).toBe(0);
  });

  it("drops the run when it is cancelled", async () => {
    const { rootRunId } = await startFixture("long-step.workflow.json");
    expect(live.cancel(rootRunId)).toBe(true);
    // A second cancel of a still-unwinding run answers true again — a no-op, not a refusal.
    expect(live.cancel(rootRunId)).toBe(true);

    expect(await awaitSettled(rootRunId)).toBe("cancelled");
    expect(live.cancellable).toBe(0);
  });

  it("holds exactly one entry per root run, not one per run in the tree", async () => {
    const { rootRunId } = await startFixture("two-slow-steps.workflow.json");
    // `run-started` fires for every run in the tree; they share one root id, so this must not grow
    // as the steps start.
    await new Promise((r) => setTimeout(r, 250));
    expect(live.cancellable).toBe(1);

    await awaitSettled(rootRunId);
    expect(live.cancellable).toBe(0);
  });

  it("holds concurrent runs side by side, each dropped as it settles", async () => {
    const [a, b] = await Promise.all([
      startFixture("slow-step.workflow.json"),
      startFixture("long-step.workflow.json"),
    ]);
    expect(live.cancellable).toBe(2);

    expect(await awaitSettled(a.rootRunId)).toBe("succeeded");
    // The other run is untouched by its sibling settling — a cancel of it must still work.
    expect(live.cancellable).toBe(1);
    expect(live.cancel(b.rootRunId)).toBe(true);

    expect(await awaitSettled(b.rootRunId)).toBe("cancelled");
    expect(live.cancellable).toBe(0);
  });
});

describe("LiveRuns — stream", () => {
  function collect(rootRunId: string, afterSeq?: number) {
    const events: LogEvent[] = [];
    let ended = false;
    const unsubscribe = live.stream(rootRunId, afterSeq, {
      onEvent: (event) => events.push(event),
      onEnd: () => {
        ended = true;
      },
    });
    return { events, unsubscribe, ended: () => ended };
  }

  it("delivers live events in seq order and ends when the run finishes", async () => {
    const { rootRunId } = await startFixture("slow-step.workflow.json");
    const stream = collect(rootRunId);

    expect(await awaitSettled(rootRunId)).toBe("succeeded");
    await tick();

    expect(stream.ended()).toBe(true);
    expect(stream.events.map((event) => event.seq)).toEqual(
      [...stream.events.map((event) => event.seq)].sort((a, b) => a - b),
    );
    expect(stream.events.some((event) => event.type === "step-finished")).toBe(true);
  });

  it("replays a finished run's whole narrative, then ends immediately", async () => {
    const { rootRunId } = await startFixture("slow-step.workflow.json");
    await awaitSettled(rootRunId);
    await tick();

    const stream = collect(rootRunId);

    expect(stream.ended()).toBe(true);
    expect(stream.events.length).toBeGreaterThan(0);
    expect(stream.events[0]!.seq).toBe(1);
  });

  it("replays only what a reconnecting subscriber hasn't seen", async () => {
    const { rootRunId } = await startFixture("slow-step.workflow.json");
    await awaitSettled(rootRunId);
    await tick();

    const whole = collect(rootRunId).events;
    const resumed = collect(rootRunId, whole[0]!.seq).events;

    expect(resumed.map((event) => event.seq)).toEqual(whole.slice(1).map((event) => event.seq));
  });

  it("hands a mid-run subscriber replay then live, with no gap and no duplicate", async () => {
    const { rootRunId } = await startFixture("two-slow-steps.workflow.json");
    // Late enough that some events are already persisted, early enough that more are still coming.
    await new Promise((r) => setTimeout(r, 150));

    const stream = collect(rootRunId);
    expect(await awaitSettled(rootRunId)).toBe("succeeded");
    await tick();

    const seqs = stream.events.map((event) => event.seq);
    expect(seqs).toEqual([...new Set(seqs)]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // Contiguous from 1: nothing published mid-read was dropped between replay and live.
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("ends a subscriber to a run this process knows nothing about", () => {
    const stream = collect("never-existed");

    expect(stream.ended()).toBe(true);
    expect(stream.events).toEqual([]);
  });

  it("stops delivering once a subscriber unsubscribes", async () => {
    const { rootRunId } = await startFixture("two-slow-steps.workflow.json");
    const stream = collect(rootRunId);
    stream.unsubscribe();
    const seen = stream.events.length;

    await awaitSettled(rootRunId);
    await tick();

    expect(stream.events.length).toBe(seen);
    expect(stream.ended()).toBe(false);
  });
});

/**
 * The path `runWorkflow` explicitly does not control: "any other thrown error is a bug and
 * propagates — it is not swallowed into a failed run". There is no terminal event on it, so the
 * live backend's `close` never runs, and before #74 the channel outlived the run — leaving every
 * subscriber hanging, because a subscriber's end is wired to the channel's close.
 *
 * Reproduced by standing in for the engine: drive the observers and backends the way a real run's
 * `run-started` does, then reject without ever emitting a terminal event.
 */
describe("LiveRuns — a run that rejects without a terminal event", () => {
  const CRASHED_ROOT = "crashed-root-1";

  function crashingLive(): LiveRuns {
    const crashing: Project = {
      ...project,
      async run(_rootFile, _workflowDir, opts = {}) {
        for (const backend of opts.extraBackends ?? []) {
          await backend.open({ runId: CRASHED_ROOT, format: "path/log@0" });
        }
        for (const observer of opts.extraObservers ?? []) {
          await observer.observe({
            type: "run-started",
            runId: CRASHED_ROOT,
            rootRunId: CRASHED_ROOT,
            parentRunId: null,
            nodeId: null,
            input: {},
            worker: { type: "engine" },
          });
        }
        throw new Error("engine bug");
      },
    };
    return createLiveRuns(crashing);
  }

  it("leaves no live channel behind, so a later subscriber is ended rather than hung", async () => {
    const runs = crashingLive();
    await startFixture("two-binary-steps.workflow.json", runs);
    await tick();

    let ended = false;
    runs.stream(CRASHED_ROOT, undefined, { onEvent: () => {}, onEnd: () => (ended = true) });
    expect(ended).toBe(true);
  });

  it("ends the subscribers it already had", async () => {
    const runs = crashingLive();
    let ended = false;

    // Subscribe the moment the channel opens, as a `GET /events` request would.
    const started = startFixture("two-binary-steps.workflow.json", runs);
    queueMicrotask(() => {
      runs.stream(CRASHED_ROOT, undefined, { onEvent: () => {}, onEnd: () => (ended = true) });
    });
    await started;
    await tick();

    expect(ended).toBe(true);
  });

  it("drops the run from the cancellable set too", async () => {
    const runs = crashingLive();
    await startFixture("two-binary-steps.workflow.json", runs);
    await tick();

    expect(runs.cancellable).toBe(0);
  });
});
