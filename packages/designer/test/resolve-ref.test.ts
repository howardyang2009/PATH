import { describe, expect, it } from "vitest";
import { basename, relativeRefPath, resolveRefPath } from "../src/resolve-ref.js";

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

describe("relativeRefPath", () => {
  it("is the inverse of resolveRefPath for a same-directory child", () => {
    expect(relativeRefPath("flows/parent.workflow.json", "flows/child.workflow.json")).toBe("child.workflow.json");
    expect(resolveRefPath("flows/parent.workflow.json", relativeRefPath("flows/parent.workflow.json", "flows/child.workflow.json"))).toBe(
      "flows/child.workflow.json",
    );
  });

  it("descends into a subdirectory from a root file", () => {
    expect(relativeRefPath("parent.workflow.json", "sub/child.workflow.json")).toBe("sub/child.workflow.json");
  });

  it("climbs out with .. when the target is in a sibling directory", () => {
    expect(relativeRefPath("a/b/parent.workflow.json", "a/c/child.workflow.json")).toBe("../c/child.workflow.json");
    expect(resolveRefPath("a/b/parent.workflow.json", "../c/child.workflow.json")).toBe("a/c/child.workflow.json");
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("flows/sub/child.workflow.json")).toBe("child.workflow.json");
    expect(basename("top.workflow.json")).toBe("top.workflow.json");
  });
});
