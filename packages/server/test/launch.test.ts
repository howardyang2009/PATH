import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { operatorConfigEnvError, prepareWorkflow } from "../src/launch.js";

/**
 * The launch-preparation seam both `POST /v0/runs` and the resume route sit behind, tested through
 * its own interface rather than through a bound port. Each refusal here is a status/message a route
 * turns straight into `sendError`; the routes' own tests still pin that mapping end to end.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("operatorConfigEnvError (ADR 0012)", () => {
  it("passes a clean config and a literal $secret", () => {
    expect(operatorConfigEnvError({})).toBeUndefined();
    expect(operatorConfigEnvError({ token: { $secret: "hunter2" } })).toBeUndefined();
  });

  it("rejects a bare $env, naming the config key", () => {
    const message = operatorConfigEnvError({ repo_path: { $env: "SECRET_X" } });
    expect(message).toContain("$env");
    expect(message).toContain("repo_path");
  });

  it("rejects the composed $secret-over-$env form at the config key, not key.$secret", () => {
    const message = operatorConfigEnvError({ token: { $secret: { $env: "SECRET_X" } } });
    expect(message).toContain("$env");
    expect(message).toContain("token");
    expect(message).not.toContain("$secret");
  });
});

describe("prepareWorkflow", () => {
  const notFound = (p: string) => `not found: ${p}`;

  it("loads a valid workflow within the project root", () => {
    const prepared = prepareWorkflow(fixturesDir, "two-binary-steps.workflow.json", notFound);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.workflow.rootFile.name).toBe("two-binary-steps");
    // The three derived facts of the loaded workflow ride through untouched (candidate 1).
    expect(prepared.workflow.workflowDir).toBe(fixturesDir);
    expect(prepared.workflow.storeRelativePath(fixturesDir)).toBe("two-binary-steps.workflow.json");
  });

  it("404s a path that escapes the project root, with its own wording", () => {
    const prepared = prepareWorkflow(fixturesDir, "../../etc/passwd", notFound);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(404);
    expect(prepared.refusal.message).toContain("outside the project root");
  });

  it("404s a missing file with the caller's notFound message", () => {
    const prepared = prepareWorkflow(fixturesDir, "does-not-exist.workflow.json", notFound);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(404);
    expect(prepared.refusal.message).toBe("not found: does-not-exist.workflow.json");
  });

  it("400s an invalid file, carrying the loader's per-file errors as details", () => {
    const prepared = prepareWorkflow(fixturesDir, "invalid-schema.workflow.json", notFound);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.refusal.status).toBe(400);
    expect(prepared.refusal.message).toBe("workflow validation failed");
    expect(prepared.refusal.details?.length).toBeGreaterThan(0);
  });
});
