import { describe, expect, it } from "vitest";
import { parseRemoveSharedArgs, parseServerArgs } from "../src/cli.js";

const SHARED = "shared/workflow/abuse.workflow.json";

describe("parseServerArgs", () => {
  it("defaults project-dir to cwd and port to 0 (ephemeral) when given no arguments", () => {
    const result = parseServerArgs([], "/cwd");
    expect(result).toEqual({ success: true, args: { projectDir: "/cwd", port: 0 } });
  });

  it("takes project-dir as the positional argument", () => {
    const result = parseServerArgs(["/some/project"], "/cwd");
    expect(result).toEqual({ success: true, args: { projectDir: "/some/project", port: 0 } });
  });

  it("parses --port", () => {
    const result = parseServerArgs(["/some/project", "--port", "4000"], "/cwd");
    expect(result).toEqual({ success: true, args: { projectDir: "/some/project", port: 4000 } });
  });

  it("accepts --port before the project-dir positional", () => {
    const result = parseServerArgs(["--port", "4000", "/some/project"], "/cwd");
    expect(result).toEqual({ success: true, args: { projectDir: "/some/project", port: 4000 } });
  });

  it("rejects a non-integer --port", () => {
    const result = parseServerArgs(["--port", "not-a-number"]);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("--port requires"),
    });
  });

  it("rejects a --port outside the valid range", () => {
    const result = parseServerArgs(["--port", "70000"]);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("--port requires"),
    });
  });

  it("rejects a second positional argument", () => {
    const result = parseServerArgs(["/a", "/b"]);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('unrecognized argument "/b"'),
    });
  });
});

describe("parseRemoveSharedArgs", () => {
  it("takes the path, a required reason and the flags, with project-dir defaulting to cwd", () => {
    expect(
      parseRemoveSharedArgs([SHARED, "--reason", "spam", "--purge", "--find-copies"], "/cwd"),
    ).toEqual({
      success: true,
      args: { projectDir: "/cwd", path: SHARED, reason: "spam", purge: true, findCopies: true },
    });
    expect(parseRemoveSharedArgs(["--project", "/p", SHARED, "--reason", "spam"], "/cwd")).toEqual({
      success: true,
      args: { projectDir: "/p", path: SHARED, reason: "spam", purge: false, findCopies: false },
    });
  });

  it("refuses a missing path or reason and an unknown argument", () => {
    expect(parseRemoveSharedArgs(["--reason", "x"])).toMatchObject({ success: false });
    expect(parseRemoveSharedArgs([SHARED])).toMatchObject({
      success: false,
      error: expect.stringContaining("--reason"),
    });
    expect(parseRemoveSharedArgs([SHARED, "--reason", "x", "extra"])).toMatchObject({
      success: false,
      error: expect.stringContaining('unrecognized argument "extra"'),
    });
  });
});
