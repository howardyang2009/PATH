import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import { describe, expect, it } from "vitest";
import { handlePostRuns, type RunsRouteContext } from "../src/routes/post-runs.js";
import type { LiveRuns, StartRunOptions } from "../src/live-runs.js";

/**
 * `POST /v0/runs` carries the operator's **launch worker-default** table (ADR 0044, #517): a top-level
 * `worker_defaults` field, a peer of `input`/`config`, that feeds the same engine launch table the CLI
 * `--worker-default` fills. The route's one new job is to fold that field into `StartRunOptions
 * .launchWorkerDefaults` verbatim — the engine's own tests own that the table then reaches un-pinned
 * steps. So this drives the handler against a recording `LiveRuns` and asserts the field that lands on
 * `start`, which is deterministic and needs no worker to run.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A `LiveRuns` whose only live method records the `start` options and answers a fixed id pair. */
function recordingLive(): { live: LiveRuns; started: StartRunOptions[] } {
  const started: StartRunOptions[] = [];
  const start: LiveRuns["start"] = async (_rootFile, _workflowDir, options) => {
    started.push(options);
    return { runId: "run-1", rootRunId: "run-1" };
  };
  const live = { start } as unknown as LiveRuns;
  return { live, started };
}

/** A request body streamed the way `readJsonBody` consumes it — `data` then `end`. */
function fakeReq(body: unknown) {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Parameters<typeof handlePostRuns>[0];
}

/** A response sink capturing the status the handler writes and its JSON body. */
function fakeRes(): { res: ServerResponse; result: { status?: number; body?: unknown } } {
  const result: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      result.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) result.body = JSON.parse(chunk);
    },
  } as unknown as ServerResponse;
  return { res, result };
}

function context(live: LiveRuns): RunsRouteContext {
  return {
    project: { dir: fixturesDir } as unknown as Project,
    live,
    stepPlugins: {} as unknown as LoadedStepPluginRegistry,
  };
}

const WORKFLOW = "two-binary-steps.workflow.json";

// The file-level input seed (a workflow file's own top-level `input`): `POST /v0/runs` resolves the
// effective root input here — a non-empty operator override wins, else the file's seed, else `{}` — so
// every launch door that reaches this route (the Viewer panel, the Designer's run dock) shares one rule.
describe("POST /v0/runs input resolution", () => {
  const WITH_INPUT = "file-input.workflow.json";
  const FILE_SEED = { ticket: 7, labels: ["from-file"] };

  it("falls back to the file's own input seed when the request sends no input", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WITH_INPUT }), res, context(live));

    expect(result.status).toBe(202);
    expect(started[0]!.input).toEqual(FILE_SEED);
  });

  it("treats an empty override as no override", async () => {
    const { live, started } = recordingLive();
    await handlePostRuns(fakeReq({ workflow_path: WITH_INPUT, input: {} }), fakeRes().res, context(live));
    expect(started[0]!.input).toEqual(FILE_SEED);
  });

  it("lets a non-empty override win over the file seed", async () => {
    const { live, started } = recordingLive();
    await handlePostRuns(fakeReq({ workflow_path: WITH_INPUT, input: { ticket: 9 } }), fakeRes().res, context(live));
    expect(started[0]!.input).toEqual({ ticket: 9 });
  });

  it("sends {} for a file with no seed and no override", async () => {
    const { live, started } = recordingLive();
    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW }), fakeRes().res, context(live));
    expect(started[0]!.input).toEqual({});
  });
});

// The *override* is recorded beside the effective seed (ADR 0046): `input` is what the run seeds from,
// `operatorInput` is what a reader is shown as the launch's own input. The same "empty is no override"
// rule applies, so a `{}` body never records a launch fact that did not exist.
describe("POST /v0/runs operatorInput (ADR 0046)", () => {
  it("forwards a non-empty input override as the recorded launch input", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, input: { ticket: 9 } }), res, context(live));

    expect(result.status).toBe(202);
    expect(started[0]!.operatorInput).toEqual({ ticket: 9 });
  });

  it("records no override for an empty object or an absent field", async () => {
    const empty = recordingLive();
    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, input: {} }), fakeRes().res, context(empty.live));
    expect(empty.started[0]!.operatorInput).toBeUndefined();

    const absent = recordingLive();
    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW }), fakeRes().res, context(absent.live));
    expect(absent.started[0]!.operatorInput).toBeUndefined();
  });
});

describe("POST /v0/runs worker_defaults (ADR 0044, #517)", () => {
  it("folds a top-level worker_defaults into StartRunOptions.launchWorkerDefaults verbatim", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, worker_defaults: { binary: "spawn" } }), res, context(live));

    expect(result.status).toBe(202);
    expect(started).toHaveLength(1);
    expect(started[0]!.launchWorkerDefaults).toEqual({ binary: "spawn" });
  });

  it("keeps the field beside config: a worker_defaults nested in config never reaches the launch table", async () => {
    const { live, started } = recordingLive();
    const { res } = fakeRes();

    // Dispatch never reads `config` for worker selection, so a table smuggled inside it is inert. The
    // launch table must come from the top-level field alone.
    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, config: { worker_defaults: { binary: "spawn" } } }), res, context(live));

    expect(started).toHaveLength(1);
    expect(started[0]!.launchWorkerDefaults).toBeUndefined();
  });

  it("leaves a request without worker_defaults unchanged (no launch table)", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW }), res, context(live));

    expect(result.status).toBe(202);
    expect(started[0]!.launchWorkerDefaults).toBeUndefined();
  });

  it("400s a worker_defaults with an empty type or worker name", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, worker_defaults: { binary: "" } }), res, context(live));

    expect(result.status).toBe(400);
    expect(started).toHaveLength(0);
  });
});

// The launch channel of ADR 0044's registry-relative validation (#518): a launch `worker_defaults`
// naming an absent type, or a worker a type does not ship, is a bad request — `400` before the run
// starts, checked against the workflow's real registry (the built-in `binary`/`prompt` types the
// fixtures scan). Same taxonomy as the CLI `--worker-default` boundary, prefixed `worker_defaults:`.
describe("POST /v0/runs worker_defaults registry validation (ADR 0044, #518)", () => {
  function detailsOf(result: { body?: unknown }): string {
    const body = result.body as { error?: { message?: string; details?: unknown } } | undefined;
    return JSON.stringify(body?.error ?? {});
  }

  it("400s an absent step type, naming the type and the installed list, and starts no run", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, worker_defaults: { badtype: "x" } }), res, context(live));

    expect(result.status).toBe(400);
    expect(started).toHaveLength(0);
    const details = detailsOf(result);
    expect(details).toMatch(/worker_defaults:/);
    expect(details).toMatch(/unknown step type/);
    expect(details).toMatch(/badtype/);
    expect(details).toMatch(/binary/);
    expect(details).toMatch(/prompt/);
  });

  it("400s a worker the type does not ship, listing its shipped workers", async () => {
    const { live, started } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(fakeReq({ workflow_path: WORKFLOW, worker_defaults: { prompt: "nosuchworker" } }), res, context(live));

    expect(result.status).toBe(400);
    expect(started).toHaveLength(0);
    const details = detailsOf(result);
    expect(details).toMatch(/unknown worker/);
    expect(details).toMatch(/nosuchworker/);
    expect(details).toMatch(/prompt.{0,8}ships/);
  });

  it("reports every bad entry in one pass", async () => {
    const { live } = recordingLive();
    const { res, result } = fakeRes();

    await handlePostRuns(
      fakeReq({ workflow_path: WORKFLOW, worker_defaults: { badtype: "x", prompt: "nosuchworker" } }),
      res,
      context(live),
    );

    expect(result.status).toBe(400);
    const details = detailsOf(result);
    expect(details).toMatch(/unknown step type/);
    expect(details).toMatch(/badtype/);
    expect(details).toMatch(/unknown worker/);
    expect(details).toMatch(/nosuchworker/);
  });
});
