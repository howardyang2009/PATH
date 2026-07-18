import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeParseWorkflowFile } from "../src/workflow-file.js";

const ACCEPTANCE_DIR = fileURLToPath(new URL("../../../docs/acceptance-workflow/", import.meta.url));

function loadJson(filename: string): unknown {
  return JSON.parse(readFileSync(new URL(filename, `file://${ACCEPTANCE_DIR}`), "utf-8"));
}

describe("real acceptance workflow files validate clean", () => {
  it("validates release-notes.workflow.json", () => {
    const result = safeParseWorkflowFile(loadJson("release-notes.workflow.json"));
    if (!result.success) {
      throw new Error(`release-notes.workflow.json failed to validate:\n${result.errors.join("\n")}`);
    }
    expect(result.success).toBe(true);
  });

  it("validates revise-cycle.workflow.json", () => {
    const result = safeParseWorkflowFile(loadJson("revise-cycle.workflow.json"));
    if (!result.success) {
      throw new Error(`revise-cycle.workflow.json failed to validate:\n${result.errors.join("\n")}`);
    }
    expect(result.success).toBe(true);
  });
});
