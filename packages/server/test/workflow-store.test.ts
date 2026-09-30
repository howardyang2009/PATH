import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { strongEtag } from "../src/etag.js";
import { type WorkflowStore, workflowsOf } from "../src/workflow-store.js";

const SHIPPED = join("install", "shipped", "workflow", "sample.workflow.json");

let projectDir: string;
let store: WorkflowStore;

function workflow(): Record<string, unknown> {
  return {
    format: "path/workflow@6",
    id: randomUUID(),
    name: "draft",
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
  };
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-workflow-store-"));
  // The shipped root inside the project, as when PATH's own repo is the project.
  const layout = authoredLayout({
    projectDir,
    shippedDir: { workflow: join(projectDir, "install", "shipped", "workflow") },
  });
  store = workflowsOf({ layout, stepPlugins: await loadStepPluginRegistry() });
  mkdirSync(join(projectDir, "install", "shipped", "workflow"), { recursive: true });
  writeFileSync(join(projectDir, SHIPPED), JSON.stringify(workflow()));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("workflow store", () => {
  it("creates a workflow, then overwrites it only under its current etag", () => {
    const path = join("users", "local", "workflow", "draft.workflow.json");
    const created = store.write(path, workflow(), undefined);
    expect(created).toMatchObject({ ok: true, relativePath: path, created: true });

    const stale = store.write(path, workflow(), '"stale"');
    expect(stale).toMatchObject({ ok: false, status: 412 });

    const etag = strongEtag(readFileSync(join(projectDir, path)));
    expect(store.write(path, workflow(), etag)).toMatchObject({ ok: true, created: false });
  });

  it("refuses to write or remove a shipped workflow, even inside the project", () => {
    const before = readFileSync(join(projectDir, SHIPPED), "utf8");
    expect(store.write(SHIPPED, workflow(), undefined)).toMatchObject({ ok: false, status: 403 });
    const etag = strongEtag(Buffer.from(before));
    expect(store.remove(SHIPPED, etag, null)).toMatchObject({ ok: false, status: 403 });
    expect(readFileSync(join(projectDir, SHIPPED), "utf8")).toBe(before);
  });

  it("refuses a template path with a 400", () => {
    const path = join("users", "local", "template", "x.step-template.json");
    expect(store.write(path, workflow(), undefined)).toMatchObject({ ok: false, status: 400 });
    expect(existsSync(join(projectDir, path))).toBe(false);
  });

  it("refuses an invalid workflow with its issues", () => {
    const written = store.write("a.workflow.json", { format: "path/workflow@6" }, undefined);
    expect(written).toMatchObject({
      ok: false,
      status: 400,
      message: "workflow validation failed",
    });
  });

  it("removes a workflow under its current etag", () => {
    const path = "a.workflow.json";
    store.write(path, workflow(), undefined);
    const etag = strongEtag(readFileSync(join(projectDir, path)));
    expect(store.remove(path, etag, null)).toEqual({ ok: true });
    expect(existsSync(join(projectDir, path))).toBe(false);
  });
});
