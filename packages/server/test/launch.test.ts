import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { operatorConfigEnvError, prepareLaunch, prepareRunWorkflow } from "../src/launch.js";

/**
 * The launch-preparation seam both `POST /v0/runs` and the resume route sit behind, tested through
 * its own interface rather than through a bound port. Each refusal here is a status/message a route
 * turns straight into `sendError`; the routes' own tests still pin that mapping end to end.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("operatorConfigEnvError (ADR 0012)", () => {
  it("passes a clean config and a literal $secret", async () => {
    expect(operatorConfigEnvError({})).toBeUndefined();
    expect(operatorConfigEnvError({ token: { $secret: "hunter2" } })).toBeUndefined();
  });

  it("rejects a bare $env, naming the config key", async () => {
    expect(operatorConfigEnvError({ repo_path: { $env: "SECRET_X" } })).toEqual({
      code: "run.config-env",
      params: { paths: '"repo_path"' },
    });
  });

  it("rejects the composed $secret-over-$env form at the config key, not key.$secret", async () => {
    expect(operatorConfigEnvError({ token: { $secret: { $env: "SECRET_X" } } })).toEqual({
      code: "run.config-env",
      params: { paths: '"token"' },
    });
  });
});

describe("prepareLaunch", () => {
  const layout = authoredLayout({ projectDir: fixturesDir });

  it("403s a shipped workflow, which never runs in place", async () => {
    const shipped = authoredLayout({
      projectDir: fixturesDir,
      shippedDir: { workflow: fixturesDir },
    });
    const prepared = await prepareLaunch(shipped, "two-binary-steps.workflow.json");
    expect(prepared).toEqual({
      ok: false,
      refusal: { status: 403, code: "workflow.shipped-copy-first" },
    });
  });

  it("loads a valid workflow within the project root", async () => {
    const prepared = await prepareLaunch(layout, "two-binary-steps.workflow.json");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.workflow.rootFile.name).toBe("two-binary-steps");
    expect(prepared.workflow.workflowDir).toBe(fixturesDir);
    expect(prepared.workflow.storeRelativePath(fixturesDir)).toBe("two-binary-steps.workflow.json");
  });

  it("404s an escaping path as escapes-root and a missing file as not-found", async () => {
    expect(await prepareLaunch(layout, "../../etc/passwd")).toEqual({
      ok: false,
      refusal: {
        status: 404,
        code: "workflow.escapes-root",
        params: { workflowPath: "../../etc/passwd" },
      },
    });
    expect(await prepareLaunch(layout, "does-not-exist.workflow.json")).toEqual({
      ok: false,
      refusal: {
        status: 404,
        code: "workflow.not-found",
        params: { workflowPath: "does-not-exist.workflow.json" },
      },
    });
  });

  it("400s an invalid file, carrying the loader's per-file issues as details", async () => {
    const prepared = await prepareLaunch(layout, "invalid-schema.workflow.json");
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(400);
    expect(prepared.refusal.code).toBe("workflow.invalid");
    expect(prepared.refusal.details?.length).toBeGreaterThan(0);
  });
});

describe("prepareRunWorkflow", () => {
  const layout = authoredLayout({ projectDir: fixturesDir });
  const resume = { kind: "resume", rootRunId: "r1" } as const;
  const complete = { kind: "complete", rootRunId: "r1", stepRunId: "s1" } as const;

  it("names a run with no recorded path for the asking door", async () => {
    const root = { workflowId: null, workflowPath: null };
    expect(await prepareRunWorkflow(layout, root, resume)).toMatchObject({
      refusal: { status: 409, code: "run.resume.no-path", params: { rootRunId: "r1" } },
    });
    expect(await prepareRunWorkflow(layout, root, complete)).toMatchObject({
      refusal: { status: 409, code: "run.complete.no-path", params: { rootRunId: "r1" } },
    });
  });

  it("404s a gone or escaping workflow as run.workflow-missing", async () => {
    for (const workflowPath of ["gone.workflow.json", "../../etc/passwd"]) {
      expect(await prepareRunWorkflow(layout, { workflowId: null, workflowPath }, resume)).toEqual({
        ok: false,
        refusal: {
          status: 404,
          code: "run.workflow-missing",
          params: { rootRunId: "r1", workflowPath },
        },
      });
    }
  });

  it("409s a workflow whose id changed since the run, for the asking door", async () => {
    const root = { workflowId: "not-this-one", workflowPath: "two-binary-steps.workflow.json" };
    expect(await prepareRunWorkflow(layout, root, complete)).toMatchObject({
      refusal: {
        status: 409,
        code: "run.complete.swapped",
        params: { workflowPath: "two-binary-steps.workflow.json", rootRunId: "r1" },
      },
    });
  });
});
