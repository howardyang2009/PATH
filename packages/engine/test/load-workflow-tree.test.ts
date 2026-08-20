import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkflowTree } from "../src/load-workflow-tree.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadWorkflowTree", () => {
  it("loads a single-file workflow", () => {
    const result = loadWorkflowTree(join(fixtures, "two-binary-steps.workflow.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tree.files.size).toBe(1);
      expect(result.tree.files.get(result.tree.rootPath)?.name).toBe("two-binary-steps");
    }
  });

  it("follows a workflow-step ref and loads the whole tree", () => {
    const result = loadWorkflowTree(join(fixtures, "parent-with-child.workflow.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.tree.files.size).toBe(2);
      const names = [...result.tree.files.values()].map((f) => f.name).sort();
      expect(names).toEqual(["child", "parent-with-child"]);
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

  const CODEMOD_ERROR = {
    v0: "path/workflow@0 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2",
    v1: "path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "path-superseded-format-"));

    // A genuine `@1` file: its `parallel` branches are the pre-`@2` `{ id, name, body }` wrappers,
    // which are not nodes under `@2`. Every one of them would raise its own zod issue, so this also
    // pins that the format check fires *first* — one targeted sentence, not a wall of shape errors.
    writeFileSync(
      join(dir, "v1.workflow.json"),
      JSON.stringify({
        format: "path/workflow@1",
        id: "1b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10",
        name: "old-v1",
        worker: { type: "engine" },
        body: [
          {
            type: "parallel",
            id: "2b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10",
            name: "fan-out",
            join: "collect",
            branches: [
              {
                id: "3b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10",
                name: "left",
                body: [{ type: "binary", id: "4b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10", name: "left-step", command: "echo" }],
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
        id: "5b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10",
        name: "parent",
        worker: { type: "engine" },
        body: [{ type: "workflow", id: "6b57f0e6-2f0e-4a4a-9a37-0a2f5f0c9a10", name: "child-step", ref: "./v1.workflow.json" }],
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
      expect(result.errors).toEqual([`${absPath}: ${CODEMOD_ERROR.v1}`]);
    }
  });

  it("rejects a @0 entry file with the codemod message and nothing else", () => {
    const absPath = join(dir, "v0.workflow.json");
    const result = loadWorkflowTree(absPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([`${absPath}: ${CODEMOD_ERROR.v0}`]);
    }
  });

  it("rejects a superseded file reached as a nested ref, naming that file's path", () => {
    const result = loadWorkflowTree(join(dir, "parent.workflow.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      // The parent itself is fine — only the child is named, so the operator knows which file to migrate.
      expect(result.errors).toEqual([`${join(dir, "v1.workflow.json")}: ${CODEMOD_ERROR.v1}`]);
    }
  });
});
