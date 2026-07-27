import { cpSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getRunsForRoot, openProject, type Project } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handlePostRuns, type RunsRouteContext } from "../src/routes/post-runs.js";
import { RunControllers } from "../src/run-controllers.js";
import { RunEventHub } from "../src/run-event-hub.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * The controller registry's lifecycle is not observable through the HTTP surface — once a run is
 * terminal the cancel route refuses on terminality before it ever consults the registry — so these
 * drive `handlePostRuns` directly against a context whose registry the test can read. A leaked
 * entry is a slow leak in a long-lived server; a missing one is a refused cancel of a live run.
 */
let projectDir: string;
let project: Project;
let ctx: RunsRouteContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-registry-test-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  project = opened.project;
  ctx = { project, hub: new RunEventHub(), controllers: new RunControllers() };
});

afterEach(() => {
  project.close();
  rmSync(projectDir, { recursive: true, force: true });
});

/** The smallest surface `handlePostRuns` uses of a response: a status, and a JSON body. */
function fakeResponse(): { res: ServerResponse; status(): number; json(): unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  return { res: res as unknown as ServerResponse, status: () => status, json: () => JSON.parse(body) };
}

async function postRun(workflowPath: string): Promise<{ status: number; rootRunId: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify({ workflow_path: workflowPath }))]) as IncomingMessage;
  const captured = fakeResponse();
  await handlePostRuns(req, captured.res, ctx);
  const body = captured.json() as { root_run_id: string };
  return { status: captured.status(), rootRunId: body.root_run_id };
}

/** Waits for the root row to reach a terminal status, then lets the run promise's settle handler run. */
async function awaitSettled(rootRunId: string): Promise<string> {
  for (;;) {
    const root = getRunsForRoot(project.db, rootRunId).find((r) => r.runId === rootRunId);
    if (root && root.status !== "pending" && root.status !== "running") {
      // The row is written by the `runFinished` observer, which fires *before* `runWorkflow`'s
      // promise settles — give the `.then` that drops the controller its turn.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
      return root.status;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("handlePostRuns — controller registry lifecycle", () => {
  it("registers the run while it executes and drops it once it succeeds", async () => {
    const { status, rootRunId } = await postRun("slow-step.workflow.json");
    expect(status).toBe(202);
    // Registered under the id the client was just handed — which is what makes it cancellable.
    expect(ctx.controllers.size).toBe(1);
    expect(ctx.controllers.abort("no-such-run")).toBe(false);

    expect(await awaitSettled(rootRunId)).toBe("succeeded");
    expect(ctx.controllers.size).toBe(0);
  });

  it("drops the controller when the run fails, not only when it succeeds", async () => {
    const { rootRunId } = await postRun("failing-step.workflow.json");
    expect(await awaitSettled(rootRunId)).toBe("failed");
    expect(ctx.controllers.size).toBe(0);
  });

  it("drops the controller when the run is cancelled", async () => {
    const { rootRunId } = await postRun("long-step.workflow.json");
    expect(ctx.controllers.abort(rootRunId)).toBe(true);

    expect(await awaitSettled(rootRunId)).toBe("cancelled");
    expect(ctx.controllers.size).toBe(0);
  });

  it("registers exactly one entry per root run, not one per run in the tree", async () => {
    const { rootRunId } = await postRun("two-slow-steps.workflow.json");
    // `runStarted` fires for every run in the tree; they share one `root_run_id`, so the registry
    // must not grow as the steps start.
    await new Promise((r) => setTimeout(r, 250));
    expect(ctx.controllers.size).toBe(1);

    await awaitSettled(rootRunId);
    expect(ctx.controllers.size).toBe(0);
  });

  it("registers nothing when the run never starts (validation failed before `runStarted`)", async () => {
    const req = Readable.from([Buffer.from(JSON.stringify({ workflow_path: "invalid-schema.workflow.json" }))]);
    const captured = fakeResponse();
    await handlePostRuns(req as IncomingMessage, captured.res, ctx);

    expect(captured.status()).toBe(400);
    expect(ctx.controllers.size).toBe(0);
  });

  it("runs concurrently held side by side, each dropped as it settles", async () => {
    const [a, b] = await Promise.all([postRun("slow-step.workflow.json"), postRun("long-step.workflow.json")]);
    expect(ctx.controllers.size).toBe(2);

    expect(await awaitSettled(a.rootRunId)).toBe("succeeded");
    // The other run is untouched by its sibling settling — a cancel of it must still work.
    expect(ctx.controllers.size).toBe(1);
    expect(ctx.controllers.abort(b.rootRunId)).toBe(true);

    expect(await awaitSettled(b.rootRunId)).toBe("cancelled");
    expect(ctx.controllers.size).toBe(0);
  });
});
