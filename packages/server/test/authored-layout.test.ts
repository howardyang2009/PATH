import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthoredLayout, authoredLayout } from "../src/authored-layout.js";

let projectDir: string;
let layout: AuthoredLayout;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-authored-layout-"));
  // The shipped roots sit inside the project, as they do when PATH's own repo is the project.
  layout = authoredLayout({
    projectDir,
    shippedDir: {
      workflow: join(projectDir, "install", "shipped", "workflow"),
      template: join(projectDir, "install", "shipped", "template"),
    },
  });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string): void {
  const abs = join(projectDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "{}");
}

describe("authoredLayout", () => {
  it.each([
    ["users/local/workflow/a.workflow.json", { origin: "user", kind: "workflow", writable: true }],
    [
      "shared/workflow/team/b.workflow.json",
      { origin: "shared", kind: "workflow", writable: true },
    ],
    [
      "users/local/template/t.step-template.json",
      { origin: "user", kind: "template", writable: true },
    ],
    [
      "users/someone/template/t.step-template.json",
      { origin: "user", kind: "template", writable: true },
    ],
    [
      "shared/template/t.step-template.json",
      { origin: "shared", kind: "template", writable: true },
    ],
    [
      "install/shipped/workflow/c.workflow.json",
      { origin: "shipped", kind: "workflow", writable: false },
    ],
    [
      "users/local/workflow/../../../shared/template/x.json",
      { origin: "shared", kind: "template", writable: true },
    ],
  ])("classifies %s", (path, place) => {
    expect(layout.classify(path)).toMatchObject(place);
  });

  it("classifies a path under no authored root as undefined", () => {
    expect(layout.classify("top.workflow.json")).toBeUndefined();
    expect(layout.classify("users/template.workflow.json")).toBeUndefined();
  });

  it("refuses a template path to every workflow door, and a shipped path to write and run", () => {
    expect(layout.workflowRefusal("shared/template/t.step-template.json", "write")).toEqual({
      status: 400,
      message: "workflow path must not be a template path",
    });
    expect(layout.workflowRefusal("install/shipped/workflow/c.workflow.json", "write")).toEqual({
      status: 403,
      message: "a shipped workflow is read-only",
    });
    expect(layout.workflowRefusal("install/shipped/workflow/c.workflow.json", "run")).toEqual({
      status: 403,
      message: "a shipped workflow must be copied before it runs",
    });
    expect(layout.workflowRefusal("users/local/workflow/a.workflow.json", "run")).toBeUndefined();
  });

  it("lists each kind's files in precedence order: shipped, shared, user", () => {
    write("users/local/workflow/u.workflow.json");
    write("shared/workflow/s.workflow.json");
    write("install/shipped/workflow/p.workflow.json");
    write("shared/template/t.step-template.json");

    expect(layout.files("workflow").map(({ root }) => root.origin)).toEqual([
      "shipped",
      "shared",
      "user",
    ]);
    expect(layout.files("template").map(({ root }) => root.origin)).toEqual(["shared"]);
  });
});
