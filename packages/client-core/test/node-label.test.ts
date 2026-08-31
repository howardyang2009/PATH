import { describe, expect, it } from "vitest";
import { nodeEventLabel, nodeLabel } from "../src/node-label.js";

/**
 * How a run and its log events are named, shared by the run tree and the narrative so the same run
 * reads the same way in both (#359). The implicit root step has no node id and no node name
 * (CONTEXT.md, "Core execution model"), so the null case is the one that must not read as a blank.
 */
describe("nodeLabel", () => {
  it("names a node by its id", () => {
    expect(nodeLabel("n1")).toBe("n1");
  });

  it("names the implicit root step 'root' when the id is null", () => {
    expect(nodeLabel(null)).toBe("root");
  });
});

describe("nodeEventLabel", () => {
  it("shows both the human name and the id when both are present", () => {
    expect(nodeEventLabel("n1", "step-a")).toBe("step-a (n1)");
  });

  it("falls back to the id alone for a name-less node", () => {
    expect(nodeEventLabel("n1", null)).toBe("n1");
    expect(nodeEventLabel("n1", undefined)).toBe("n1");
  });

  it("reads the root step as 'root' when id and name are both null", () => {
    expect(nodeEventLabel(null, null)).toBe("root");
  });

  it("shows the name alone when the id is null but a name is present", () => {
    expect(nodeEventLabel(null, "workflow")).toBe("workflow");
  });
});
