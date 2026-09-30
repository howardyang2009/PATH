import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { loadWorkflowTree } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { DEFAULT_SHIPPED_WORKFLOW_DIR } from "../src/shipped-workflows.js";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-shipped-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-shipped-workflows-"));
  handle = undefined;
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
});

let idCounter = 0;
function uuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function workflow(name: string, refs: string[] = []): Record<string, unknown> {
  const body =
    refs.length > 0
      ? refs.map((ref, i) => ({ type: "workflow", id: uuid(), name: `child-${i}`, ref }))
      : [{ type: "binary", id: uuid(), name: "step-one", command: "echo" }];
  return { format: "path/workflow@6", id: uuid(), name, body };
}

function writeShipped(relPath: string, content: unknown): void {
  const abs = join(shippedDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content));
}

function readJson(relPath: string): { id: string; body: { id: string }[] } {
  return JSON.parse(readFileSync(join(projectDir, relPath), "utf8"));
}

async function copy(shippedPath: string): Promise<Response> {
  handle ??= await startPathServer(
    projectDir,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    shippedDir,
  );
  return fetch(`${handle.url}/v0/workflows/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shipped_path: shippedPath }),
  });
}

describe("POST /v0/workflows/copy", () => {
  it("copies a top-level shipped file alone, with fresh ids", async () => {
    const source = workflow("solo");
    writeShipped("solo.workflow.json", source);
    writeShipped("other.workflow.json", workflow("other"));

    const res = await copy("solo.workflow.json");
    expect(res.status).toBe(201);
    const target = join("users", "local", "workflow", "solo.workflow.json");
    expect(await res.json()).toEqual({ relative_path: target });

    const copied = readJson(target);
    expect(copied).toMatchObject({ name: "solo" });
    expect(copied.id).not.toBe(source.id);
    expect(copied.body[0]?.id).not.toBe((source.body as { id: string }[])[0]?.id);
    expect(existsSync(join(projectDir, "users", "local", "workflow", "other.workflow.json"))).toBe(
      false,
    );
  });

  it("copies the whole top-level folder of a foldered file, so its refs still resolve", async () => {
    writeShipped("notes/main.workflow.json", workflow("main", ["./lib/child.workflow.json"]));
    writeShipped("notes/lib/child.workflow.json", workflow("child"));
    writeShipped("notes/README.md", "read me");

    const res = await copy("notes/lib/child.workflow.json");
    expect(res.status).toBe(201);
    const root = join("users", "local", "workflow", "notes");
    expect(await res.json()).toEqual({ relative_path: join(root, "lib", "child.workflow.json") });

    expect(readFileSync(join(projectDir, root, "README.md"), "utf8")).toBe("read me");
    const loaded = await loadWorkflowTree(join(projectDir, root, "main.workflow.json"));
    expect(loaded.success).toBe(true);
  });

  it("refuses to overwrite an existing copy (409)", async () => {
    writeShipped("notes/main.workflow.json", workflow("main"));
    expect((await copy("notes/main.workflow.json")).status).toBe(201);
    expect((await copy("notes/main.workflow.json")).status).toBe(409);
  });

  it("404s a path that is not a shipped workflow file", async () => {
    writeShipped("notes/README.md", "read me");
    expect((await copy("missing.workflow.json")).status).toBe(404);
    expect((await copy("notes/README.md")).status).toBe(404);
    expect((await copy("../escape.workflow.json")).status).toBe(404);
  });
});

/** Every shipped `*.workflow.json`, relative to the shipped root. */
function shippedFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.json"))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

describe("shipped workflows", () => {
  it("each one loads valid and refs only files in its own top-level folder", async () => {
    const files = shippedFiles(DEFAULT_SHIPPED_WORKFLOW_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const abs = join(DEFAULT_SHIPPED_WORKFLOW_DIR, file);
      const loaded = await loadWorkflowTree(abs);
      expect({ file, success: loaded.success }).toEqual({ file, success: true });
      if (!loaded.success) continue;

      // Copy moves one top-level folder (or one top-level file), so every ref must stay inside it.
      const [top] = file.split(sep);
      for (const key of loaded.workflow.files.keys()) {
        const within = relative(DEFAULT_SHIPPED_WORKFLOW_DIR, key);
        expect({ file, ref: within }).toEqual({
          file,
          ref: file.includes(sep) ? expect.stringMatching(new RegExp(`^${top}\\${sep}`)) : file,
        });
      }
    }
  });
});
