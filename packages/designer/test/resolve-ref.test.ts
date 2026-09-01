import { describe, expect, it } from "vitest";
import { basename, resolveRefPath } from "../src/resolve-ref.js";

describe("resolveRefPath", () => {
  it("resolves a ref against the referring file's directory", () => {
    expect(resolveRefPath("flows/main.workflow.json", "sub/child.workflow.json")).toBe("flows/sub/child.workflow.json");
  });

  it("resolves a sibling ref from a file at the project root", () => {
    expect(resolveRefPath("main.workflow.json", "child.workflow.json")).toBe("child.workflow.json");
  });

  it("collapses . and .. segments", () => {
    expect(resolveRefPath("a/b/main.workflow.json", "../c/child.workflow.json")).toBe("a/c/child.workflow.json");
    expect(resolveRefPath("a/b/main.workflow.json", "./child.workflow.json")).toBe("a/b/child.workflow.json");
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("flows/sub/child.workflow.json")).toBe("child.workflow.json");
    expect(basename("top.workflow.json")).toBe("top.workflow.json");
  });
});
