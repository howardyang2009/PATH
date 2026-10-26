import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { operatorConfigEnvError, prepareWorkflow } from "../src/launch.js";

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

describe("prepareWorkflow", () => {
  const layout = authoredLayout({ projectDir: fixturesDir });
  const notFound = (p: string) =>
    ({ code: "workflow.not-found", params: { workflowPath: p } }) as const;

  it("403s a shipped workflow, which never runs in place", async () => {
    const shipped = authoredLayout({
      projectDir: fixturesDir,
      shippedDir: { workflow: fixturesDir },
    });
    const prepared = await prepareWorkflow(shipped, "two-binary-steps.workflow.json", { notFound });
    expect(prepared).toEqual({
      ok: false,
      refusal: { status: 403, code: "workflow.shipped-copy-first" },
    });
  });

  it("loads a valid workflow within the project root", async () => {
    const prepared = await prepareWorkflow(layout, "two-binary-steps.workflow.json", {
      notFound,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.workflow.rootFile.name).toBe("two-binary-steps");
    // The three derived facts of the loaded workflow ride through untouched (candidate 1).
    expect(prepared.workflow.workflowDir).toBe(fixturesDir);
    expect(prepared.workflow.storeRelativePath(fixturesDir)).toBe("two-binary-steps.workflow.json");
  });

  it("404s an escaping path with escapesRoot when given, else folds into notFound", async () => {
    // Fresh-launch shape: escape and not-found are distinct messages.
    const distinct = await prepareWorkflow(layout, "../../etc/passwd", {
      notFound,
      escapesRoot: (p) => ({ code: "workflow.escapes-root", params: { workflowPath: p } }),
    });
    expect(distinct.ok).toBe(false);
    if (distinct.ok) return;
    expect(distinct.refusal.status).toBe(404);
    expect(distinct.refusal).toMatchObject({
      code: "workflow.escapes-root",
      params: { workflowPath: "../../etc/passwd" },
    });

    // Resume shape: no escapesRoot, so an escape reuses the notFound wording (one 404 for both).
    const folded = await prepareWorkflow(layout, "../../etc/passwd", { notFound });
    expect(folded.ok).toBe(false);
    if (folded.ok) return;
    expect(folded.refusal.status).toBe(404);
    expect(folded.refusal).toMatchObject({
      code: "workflow.not-found",
      params: { workflowPath: "../../etc/passwd" },
    });
  });

  it("404s a missing file with the caller's notFound message", async () => {
    const prepared = await prepareWorkflow(layout, "does-not-exist.workflow.json", {
      notFound,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(404);
    expect(prepared.refusal).toMatchObject({
      code: "workflow.not-found",
      params: { workflowPath: "does-not-exist.workflow.json" },
    });
  });

  it("400s an invalid file, carrying the loader's per-file errors as details", async () => {
    const prepared = await prepareWorkflow(layout, "invalid-schema.workflow.json", {
      notFound,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(400);
    expect(prepared.refusal.code).toBe("workflow.invalid");
    expect(prepared.refusal.details?.length).toBeGreaterThan(0);
  });
});
