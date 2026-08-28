import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListWorkflowsResponse, WorkflowSummary } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-workflows-test-"));
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

let idCounter = 0;
function uuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

/**
 * A minimal valid workflow file. With no refs the body is a single leaf `binary` step; each `ref`
 * becomes a nested `workflow` step (the body must be non-empty — `NodeArraySchema.min(1)`).
 */
function workflow(name: string, refs: string[] = []): string {
  const body =
    refs.length > 0
      ? refs.map((ref, i) => ({ type: "workflow", id: uuid(), name: `child-${i}`, ref }))
      : [{ type: "binary", id: uuid(), name: "step-one", command: "echo" }];
  return JSON.stringify({ format: "path/workflow@3", id: uuid(), name, body });
}

function write(relPath: string, content: string): void {
  const abs = join(projectDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function listWorkflows(): Promise<{ status: number; body: ListWorkflowsResponse }> {
  handle = await startPathServer(projectDir);
  const res = await fetch(`${handle.url}/v0/workflows`);
  return { status: res.status, body: (await res.json()) as ListWorkflowsResponse };
}

function byPath(body: ListWorkflowsResponse): Map<string, WorkflowSummary> {
  return new Map(body.workflows.map((w) => [w.relative_path, w]));
}

describe("GET /v0/workflows", () => {
  it("lists all workflows, flagging a nested ref as is_root: false and its parent true", async () => {
    write("release-notes.workflow.json", workflow("release-notes", ["./lib/draft.workflow.json"]));
    write("lib/draft.workflow.json", workflow("draft"));

    const { status, body } = await listWorkflows();
    expect(status).toBe(200);
    const wf = byPath(body);

    expect(wf.get("release-notes.workflow.json")).toMatchObject({ valid: true, is_root: true, name: "release-notes" });
    expect(wf.get(join("lib", "draft.workflow.json"))).toMatchObject({ valid: true, is_root: false, name: "draft" });
  });

  it("returns an empty list for a project with no workflows", async () => {
    const { status, body } = await listWorkflows();
    expect(status).toBe(200);
    expect(body.workflows).toEqual([]);
  });

  it("flags a standalone workflow as a root and carries its id/name", async () => {
    write("solo.workflow.json", workflow("solo"));
    const wf = byPath((await listWorkflows()).body);
    const solo = wf.get("solo.workflow.json")!;
    expect(solo).toMatchObject({ valid: true, is_root: true, name: "solo", error: null });
    expect(solo.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("marks a file that is both a valid root and another root's nested ref as is_root: false", async () => {
    // C -> A -> B. A loads on its own (a valid root) yet is referenced by C, so it is not a root.
    write("a.workflow.json", workflow("a", ["./b.workflow.json"]));
    write("b.workflow.json", workflow("b"));
    write("c.workflow.json", workflow("c", ["./a.workflow.json"]));

    const wf = byPath((await listWorkflows()).body);
    expect(wf.get("a.workflow.json")).toMatchObject({ valid: true, is_root: false });
    expect(wf.get("b.workflow.json")).toMatchObject({ valid: true, is_root: false });
    expect(wf.get("c.workflow.json")).toMatchObject({ valid: true, is_root: true });
  });

  it("reports a schema-invalid file as valid: false, is_root: null, with a best-effort id/name", async () => {
    write("broken.workflow.json", JSON.stringify({ format: "path/workflow@2", id: uuid(), name: "broken", bogus: true }));

    const broken = byPath((await listWorkflows()).body).get("broken.workflow.json")!;
    expect(broken.valid).toBe(false);
    expect(broken.is_root).toBeNull();
    expect(broken.name).toBe("broken"); // shallow-parsed even though the schema load failed
    expect(broken.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(broken.error?.message).toBeTruthy();
  });

  // A project mid-migration lists its pre-`@2` files as invalid rather than hiding or upconverting
  // them, and the error carried into the listing is the targeted codemod sentence (#280,
  // workflow-format-v2.md §1) — so the operator reads the fix in the workflow list itself.
  it("reports a superseded @1 file as invalid, with the codemod named in its error", async () => {
    write(
      "old.workflow.json",
      JSON.stringify({
        format: "path/workflow@1",
        id: uuid(),
        name: "old",
        worker: { type: "engine" },
        body: [{ type: "binary", id: uuid(), name: "step-one", command: "echo" }],
      }),
    );

    const old = byPath((await listWorkflows()).body).get("old.workflow.json")!;
    expect(old).toMatchObject({ valid: false, is_root: null, name: "old" });
    expect(old.error?.message).toBe(
      `${join(projectDir, "old.workflow.json")}: path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts then scripts/migrate-workflow-format-v3.ts to migrate this file to path/workflow@3`,
    );
    expect(old.error?.details).toHaveLength(1);
  });

  it("yields null id/name for a syntactically broken file", async () => {
    write("garbage.workflow.json", "{ not valid json");

    const garbage = byPath((await listWorkflows()).body).get("garbage.workflow.json")!;
    expect(garbage).toMatchObject({ valid: false, is_root: null, id: null, name: null });
    expect(garbage.error?.message).toBeTruthy();
  });

  it("skips .path/, node_modules, and dot-directories", async () => {
    write("real.workflow.json", workflow("real"));
    write(".path/internal.workflow.json", workflow("internal"));
    write("node_modules/dep/dep.workflow.json", workflow("dep"));
    write(".hidden/secret.workflow.json", workflow("secret"));

    const paths = (await listWorkflows()).body.workflows.map((w) => w.relative_path);
    expect(paths).toEqual(["real.workflow.json"]);
  });

  it("does not follow or list a symlink, so a nested file is not aliased as a root", async () => {
    // A real nested workflow, plus a root-level symlink pointing at it. Following the symlink would
    // surface the nested file under a second path with is_root: true (valid-root-detection.md).
    write("parent.workflow.json", workflow("parent", ["./lib/child.workflow.json"]));
    write("lib/child.workflow.json", workflow("child"));
    symlinkSync(join(projectDir, "lib", "child.workflow.json"), join(projectDir, "alias.workflow.json"));

    const { body } = await listWorkflows();
    const paths = body.workflows.map((w) => w.relative_path).sort();
    expect(paths).toEqual([join("lib", "child.workflow.json"), "parent.workflow.json"]);
    // The child appears once, as a non-root; there is no aliased root entry.
    const wf = byPath(body);
    expect(wf.get(join("lib", "child.workflow.json"))).toMatchObject({ is_root: false });
    expect(wf.has("alias.workflow.json")).toBe(false);
  });

  it("does not descend into a symlinked directory", async () => {
    write("real.workflow.json", workflow("real"));
    write("target/inside.workflow.json", workflow("inside"));
    symlinkSync(join(projectDir, "target"), join(projectDir, "linkdir"));

    const paths = (await listWorkflows()).body.workflows.map((w) => w.relative_path).sort();
    // The real file inside `target/` is listed once via its own path; the `linkdir/` alias is not
    // followed, so `linkdir/inside.workflow.json` never appears.
    expect(paths).toEqual(["real.workflow.json", join("target", "inside.workflow.json")]);
  });

  it("returns relative_path as the exact launch handle POST /v0/runs accepts", async () => {
    write("deep/nested/flow.workflow.json", workflow("flow"));
    const { body } = await listWorkflows();
    const handlePath = body.workflows[0]!.relative_path;

    const res = await fetch(`${handle.url}/v0/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_path: handlePath }),
    });
    // 202 means the handle resolved and loaded — not a 404 (outside root / not found).
    expect(res.status).toBe(202);
  });
});
