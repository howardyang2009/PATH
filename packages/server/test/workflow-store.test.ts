import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthoredLayout, authoredLayout } from "../src/authored-layout.js";
import { type CreatorTable, openCreatorTable } from "../src/creator-table.js";
import { strongEtag } from "../src/etag.js";
import { type WorkflowStore, workflowsOf } from "../src/workflow-store.js";

const SHIPPED = join("install", "shipped", "workflow", "sample.workflow.json");

let projectDir: string;
let store: WorkflowStore;
let creators: CreatorTable;
let shippedDir: string;

/** The workflow store as `userId` sees it, over the one creator table. */
async function storeFor(userId: string): Promise<WorkflowStore> {
  const layout: AuthoredLayout = authoredLayout({
    projectDir,
    shippedDir: { workflow: shippedDir },
    userId,
  });
  return workflowsOf({ layout, stepPlugins: await loadStepPluginRegistry(), creators });
}

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
  shippedDir = join(projectDir, "install", "shipped", "workflow");
  creators = openCreatorTable(":memory:");
  store = await storeFor("local");
  mkdirSync(join(projectDir, "install", "shipped", "workflow"), { recursive: true });
  writeFileSync(join(projectDir, SHIPPED), JSON.stringify(workflow()));
});

afterEach(() => {
  creators.close();
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

describe("workflow store — shared items", () => {
  const SHARED = "shared/workflow/team.workflow.json";

  it("stamps the creator on create and lets only the creator overwrite or remove", async () => {
    const alice = await storeFor("user_alice");
    const bob = await storeFor("user_bob");
    expect(alice.write(SHARED, workflow(), undefined)).toMatchObject({ ok: true, created: true });
    expect(creators.creatorOf(SHARED, "workflow")).toBe("user_alice");

    const etag = strongEtag(readFileSync(join(projectDir, SHARED)));
    expect(bob.write(SHARED, workflow(), etag)).toMatchObject({
      ok: false,
      status: 403,
      message: "only the creator edits a shared item",
    });
    expect(bob.remove(SHARED, etag, null)).toMatchObject({ ok: false, status: 403 });

    expect(alice.write(SHARED, workflow(), etag)).toMatchObject({ ok: true, created: false });
    expect(creators.creatorOf(SHARED, "workflow")).toBe("user_alice");
    const next = strongEtag(readFileSync(join(projectDir, SHARED)));
    expect(alice.remove(SHARED, next, null)).toEqual({ ok: true });
    expect(creators.creatorOf(SHARED, "workflow")).toBeUndefined();
  });

  it("refuses every write to a shared file with no creator row", () => {
    mkdirSync(join(projectDir, "shared", "workflow"), { recursive: true });
    writeFileSync(join(projectDir, SHARED), JSON.stringify(workflow()));
    const etag = strongEtag(readFileSync(join(projectDir, SHARED)));

    expect(store.write(SHARED, workflow(), etag)).toMatchObject({ ok: false, status: 403 });
    expect(store.remove(SHARED, etag, null)).toMatchObject({ ok: false, status: 403 });
    expect(existsSync(join(projectDir, SHARED))).toBe(true);
  });
});
