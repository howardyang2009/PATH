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

  // The one non-obvious rule in this file: a ref is a *stored string*, read back on any OS, so it
  // never carries the host separator — unlike every path helper above. That a ref addresses the file
  // the blob was actually written to is covered where the two are produced together
  // (persisted-observer.test.ts), which is the pairing that used to be hand-maintained.
  it("computes a blob ref relative to .path/, always forward-slash-joined regardless of host OS", () => {
    const ref = blobRef("root-1", "child-2", "output.json");
    expect(ref).toBe("runs/root-1/child-2/output.json");
    expect(ref).not.toContain("\\");
    expect(ref.startsWith("/")).toBe(false); // relative to .path/, never absolute
  });
});
