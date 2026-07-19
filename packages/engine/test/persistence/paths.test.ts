import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blobRef, dbFilePath, pathDir, rootRunTreeDir, runBlobDir, runsDir } from "../../src/persistence/paths.js";

describe("persistence paths", () => {
  const project = "/tmp/some-project";

  it("puts .path/ directly beside the project directory", () => {
    expect(pathDir(project)).toBe(join(project, ".path"));
  });

  it("puts path.db inside .path/", () => {
    expect(dbFilePath(project)).toBe(join(project, ".path", "path.db"));
  });

  it("puts the runs tree inside .path/runs", () => {
    expect(runsDir(project)).toBe(join(project, ".path", "runs"));
  });

  it("keys a root run's tree directory by its run id", () => {
    expect(rootRunTreeDir(project, "root-1")).toBe(join(project, ".path", "runs", "root-1"));
  });

  it("keys a run's blob directory by root-run-id then run-id, even for the root run itself", () => {
    expect(runBlobDir(project, "root-1", "root-1")).toBe(join(project, ".path", "runs", "root-1", "root-1"));
    expect(runBlobDir(project, "root-1", "child-2")).toBe(join(project, ".path", "runs", "root-1", "child-2"));
  });

  it("computes a blob ref relative to .path/, always forward-slash-joined regardless of host OS", () => {
    expect(blobRef("root-1", "child-2", "output.json")).toBe("runs/root-1/child-2/output.json");
  });
});
