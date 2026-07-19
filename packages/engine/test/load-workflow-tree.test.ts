import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
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
