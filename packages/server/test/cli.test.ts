import { describe, expect, it } from "vitest";
import { parseServerArgs } from "../src/cli.js";

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
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("--port requires") });
  });

  it("rejects a --port outside the valid range", () => {
    const result = parseServerArgs(["--port", "70000"]);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("--port requires") });
  });

  it("rejects a second positional argument", () => {
    const result = parseServerArgs(["/a", "/b"]);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('unrecognized argument "/b"') });
  });
});
