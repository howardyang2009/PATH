import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAcceptance } from "../src/acceptance/run-acceptance.js";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let projectDir: string;
let handle: PathServerHandle;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-accept-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  handle = await startPathServer(projectDir);
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// Proves the §5 acceptance harness mechanics end-to-end against a token-free binary fixture — the
// same driver the human runs against release-notes.workflow.json with real keys (ticket #39).
describe("runAcceptance — §5 harness against a token-free fixture", () => {
  it("passes all four criteria with a disconnect/reconnect mid-run", async () => {
    const report = await runAcceptance({
      url: handle.url,
      projectDir,
      workflowPath: "two-slow-steps.workflow.json",
    });

    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c]));
    expect(report.criteria.map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
    for (const c of report.criteria) {
      expect(c.pass, `criterion ${c.id} (${c.title}): ${c.detail}`).toBe(true);
    }
    expect(report.passed).toBe(true);
    expect(report.status).toBe("succeeded");
    expect(byId["4"]!.detail).toMatch(/contiguous 1\.\.\d+/);
    // The disconnect is real, not vacuous: connection A dropped after 1 frame and the reconnect
    // replayed a non-empty tail (two-slow-steps emits well more than one event).
    expect(byId["4"]!.detail).toMatch(/disconnected mid-run/);
    expect(byId["4"]!.detail).not.toMatch(/replayed 0 of 0/);
    expect(report.narrativeSeqs).toEqual(report.narrativeSeqs.map((_, i) => i + 1));
    expect(report.narrativeSeqs.length).toBeGreaterThan(1);
  });

  it("reports criterion 1 failed (and aborts) when the workflow does not exist", async () => {
    const report = await runAcceptance({
      url: handle.url,
      projectDir,
      workflowPath: "does-not-exist.workflow.json",
    });
    expect(report.passed).toBe(false);
    const c1 = report.criteria.find((c) => c.id === "1")!;
    expect(c1.pass).toBe(false);
    // No root run started → no later criteria to evaluate.
    expect(report.rootRunId).toBeUndefined();
    expect(report.criteria).toHaveLength(1);
  });
});
