import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkflowTree } from "../src/load-workflow-tree.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadWorkflowTree", () => {
  it("loads a single-file workflow", () => {
    const result = loadWorkflowTree(join(fixtures, "two-binary-steps.workflow.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.workflow.files.size).toBe(1);
      expect(result.workflow.rootFile.name).toBe("two-binary-steps");
    }
  });

  it("follows a workflow-step ref and loads the whole tree", () => {
    const result = loadWorkflowTree(join(fixtures, "parent-with-child.workflow.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.workflow.files.size).toBe(2);
      const names = [...result.workflow.files.values()].map((f) => f.name).sort();
      expect(names).toEqual(["child", "parent-with-child"]);
      // The entry file, not just any member of the tree: `rootFile` is where the run starts.
      expect(result.workflow.rootFile.name).toBe("parent-with-child");
    }
  });

  it("reports a ref cycle before any step would execute, without infinite looping", () => {
    const result = loadWorkflowTree(join(fixtures, "cycle-a.workflow.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/cycle/i);
    }
  });

  it("reports an unresolvable ref path", () => {
    const result = loadWorkflowTree(join(fixtures, "missing-ref.workflow.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/does-not-exist\.workflow\.json/);
    }
  });

  it("reports a schema violation (unknown field) with the offending file's path", () => {
    const result = loadWorkflowTree(join(fixtures, "invalid-schema.workflow.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/invalid-schema\.workflow\.json/);
      expect(result.errors.join("\n")).toMatch(/bogus_field/);
    }
  });

  it("reports a not-found entry file", () => {
    const result = loadWorkflowTree(join(fixtures, "nope.workflow.json"));
    expect(result.success).toBe(false);
  });
});

/**
 * The three facts eight call sites used to derive from `{ rootPath, files }` by hand — the entry
 * file, the directory the engine resolves refs and `cwd`s against, and the store-relative path a
 * root run records as provenance. They are pinned here, once, because that is now the only place
 * they are computed.
 */
describe("loadWorkflowTree — what the load already knows", () => {
  const entry = join(fixtures, "parent-with-child.workflow.json");

  it("resolves a relative entry path and reports the entry file's own directory", () => {
    const result = loadWorkflowTree(relative(process.cwd(), entry));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.workflow.rootPath).toBe(entry);
    // Never the caller's cwd and never a project directory: this is what a nested `ref` and a
    // binary step's `cwd` resolve against (#59, ADR 0005).
    expect(result.workflow.workflowDir).toBe(fixtures);
  });

  it("measures the store-relative path from the store dir the caller names, not from the file", () => {
    const result = loadWorkflowTree(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // `path run` with no `-C`: the store is the file's own directory, so provenance is the filename.
    expect(result.workflow.storeRelativePath(fixtures)).toBe("parent-with-child.workflow.json");
    // A relocated `-C` store one level up: the path keeps the segment that tells two same-named
    // workflows apart (#202, ADR 0006).
    expect(result.workflow.storeRelativePath(dirname(fixtures))).toBe(
      join("fixtures", "parent-with-child.workflow.json"),
    );
  });
});

/**
 * The load boundary is where the "engine reads `@2` only" ruling is enforced (#280,
 * workflow-format-v2.md §1): a pre-migration file fails at load with a targeted message naming the
 * codemod, following the ADR 0007 precedent. `@path/schema` produces the sentence; what is pinned
 * here is that the *loader* surfaces it — with the offending file's path — instead of upconverting,
 * and that it does so for a nested ref as readily as for the entry file.
 *
 * These files are written to a temp dir rather than checked in beside the other fixtures on
 * purpose: `scripts/migrate-workflow-format-v2.ts` discovers every `*.workflow.json` in the repo, so
 * a checked-in `@1` fixture would be silently migrated to `@2` by the next codemod run and the test
 * would pass for the wrong reason.
 */
describe("loadWorkflowTree — superseded format versions", () => {
  let dir: string;

  // The two §1 sentences, spelled out rather than templated — the loader is meant to pass the
  // schema's wording through untouched, so a template here could only hide a change to it. `@0`
  // names both codemods in order: the `@2` script migrates `@1` and nothing else, so alone it would
  // leave an `@0` file exactly as unreadable as it was.
  const V1_REJECTION =
    "path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2";
  const V0_REJECTION =
    "path/workflow@0 is no longer read — run scripts/migrate-workflow-format-v1.ts then scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "path-superseded-format-"));

    // A genuine `@1` file: its `parallel` branches are the pre-`@2` `{ id, name, body }` wrappers,
    // which are not nodes under `@2`. Every one of them would raise its own zod issue, so this also
    // pins that the format check fires *first* — one targeted sentence, not a wall of shape errors.
    writeFileSync(
      join(dir, "v1.workflow.json"),
      JSON.stringify({
        format: "path/workflow@1",
        id: "e7c4a1d2-3f88-4b16-9c50-24af6d0b83e1",
        name: "old-v1",
        worker: { type: "engine" },
        body: [
          {
            type: "parallel",
            id: "5a0f92bd-c714-4e33-8a67-1d9e40c5f2b8",
            name: "fan-out",
            join: "collect",
            branches: [
              {
                id: "b3184ce9-6d20-4f51-92ac-708be1d3a64f",
                name: "left",
                body: [{ type: "binary", id: "0fd6b845-91e7-42ca-8b39-cd52704e1a97", name: "left-step", command: "echo" }],
              },
            ],
          },
        ],
      }),
    );

    // A genuine `@0` file: the human `id` predates the GUID `id` + `name` split (ADR 0006/0007), so
    // there is no `name` anywhere and the GUID check would fail too.
    writeFileSync(
      join(dir, "v0.workflow.json"),
      JSON.stringify({
        format: "path/workflow@0",
        id: "old-v0",
        worker: { type: "engine" },
        body: [{ type: "binary", id: "step-one", command: "echo" }],
      }),
    );

    // A current `@2` parent whose nested `workflow` ref still points at the `@1` file.
    writeFileSync(
      join(dir, "parent.workflow.json"),
      JSON.stringify({
        format: "path/workflow@2",
        id: "9c27e0a3-48bf-4d75-a1e6-3b840f9c62d5",
        name: "parent",
        worker: { type: "engine" },
        body: [{ type: "workflow", id: "42be13f7-a05c-4986-b7d4-6e1f28903cba", name: "child-step", ref: "./v1.workflow.json" }],
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a @1 entry file with the codemod message and nothing else", () => {
    const absPath = join(dir, "v1.workflow.json");
    const result = loadWorkflowTree(absPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([`${absPath}: ${V1_REJECTION}`]);
    }
  });

  it("rejects a @0 entry file with the codemod message and nothing else", () => {
    const absPath = join(dir, "v0.workflow.json");
    const result = loadWorkflowTree(absPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([`${absPath}: ${V0_REJECTION}`]);
    }
  });

  it("rejects a superseded file reached as a nested ref, naming that file's path", () => {
    const result = loadWorkflowTree(join(dir, "parent.workflow.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      // The parent itself is fine — only the child is named, so the operator knows which file to migrate.
      expect(result.errors).toEqual([`${join(dir, "v1.workflow.json")}: ${V1_REJECTION}`]);
    }
  });
});
