import { describe, expect, it } from "vitest";
import {
  readTemplatePlacement,
  readWorkflowStem,
  workflowPath,
} from "../src/authored-placement.js";

describe("readWorkflowStem — the one workflow filename rule", () => {
  it("strips a trailing .workflow.json, case-insensitively", () => {
    expect(readWorkflowStem("release-notes.workflow.json").stem).toBe("release-notes");
    expect(readWorkflowStem("release-notes.WORKFLOW.JSON").stem).toBe("release-notes");
  });

  it("nests subfolders and trims each segment", () => {
    expect(readWorkflowStem(" lib / drafts / flow ")).toEqual({
      stem: "lib/drafts/flow",
      problem: null,
    });
  });

  it("reads a blank field as an empty stem, not an error", () => {
    expect(readWorkflowStem("   ")).toEqual({ stem: "", problem: null });
  });

  it.each([
    ["a\\b", "backslash"],
    ["a//b", "emptySegment"],
    ["a/ /b", "emptySegment"],
    ["../escape", "dotSegment"],
    [".hidden", "dotSegment"],
    ["a/.b", "dotSegment"],
  ] as const)("refuses %s as %s", (text, problem) => {
    expect(readWorkflowStem(text).problem).toBe(problem);
  });
});

describe("workflowPath — one composition rule", () => {
  it("composes under a directory", () => {
    expect(workflowPath("users/u/workflow/lib", "flow")).toBe(
      "users/u/workflow/lib/flow.workflow.json",
    );
  });

  it("composes at the project root", () => {
    expect(workflowPath("", "flow")).toBe("flow.workflow.json");
  });
});

describe("readTemplatePlacement — the one template name rule", () => {
  it("strips the suffix and reads a plain name", () => {
    expect(readTemplatePlacement("my-gate.step-template.json", "lib")).toEqual({
      name: "my-gate",
      folder: "lib",
      problem: null,
    });
  });

  it("splits a typed subfolder off the name and joins it onto the picked folder", () => {
    expect(readTemplatePlacement("reviews/gate", "lib")).toEqual({
      name: "gate",
      folder: "lib/reviews",
      problem: null,
    });
  });

  it("keeps an empty folder undefined", () => {
    expect(readTemplatePlacement("gate", "")).toEqual({
      name: "gate",
      folder: undefined,
      problem: null,
    });
  });

  it("refuses a name that is not a plain slug", () => {
    expect(readTemplatePlacement("My Gate", "")).toMatchObject({
      name: "My Gate",
      problem: "name",
    });
    expect(readTemplatePlacement("", "")).toMatchObject({ name: "", problem: "name" });
  });

  it("refuses a folder that leaves its root", () => {
    expect(readTemplatePlacement("gate", "../escape")).toMatchObject({ problem: "folder" });
    expect(readTemplatePlacement("gate", "a\\b")).toMatchObject({ problem: "folder" });
  });
});
