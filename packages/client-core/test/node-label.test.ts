import { verbatim } from "@path/i18n";
import { describe, expect, it } from "vitest";
import { nodeEventLabel, nodeLabel } from "../src/node-label.js";

/**
 * How a run and its log events are named, shared by the run tree and the narrative so the same run
 * reads the same way in both (#359). The implicit root step has no node id and no node name
 * (CONTEXT.md, "Core execution model"), so the null case is the one that must not read as a blank.
 * The event label is a `Message`: the name and the short id ride as data inside the catalogue's
 * one joining sentence.
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
    expect(nodeEventLabel("n1", "step-a")).toEqual({
      key: "events.nodeLabel.named",
      params: { name: "step-a", shortId: "n1" },
    });
  });

  it("shortens a GUID node id to its first 8 characters", () => {
    expect(nodeEventLabel("3f2a9c1e-7b4d-4e8a-9f00-123456789abc", "step-a")).toEqual({
      key: "events.nodeLabel.named",
      params: { name: "step-a", shortId: "3f2a9c1e" },
    });
  });

  it("falls back to the id alone for a name-less node", () => {
    expect(nodeEventLabel("n1", null)).toEqual(verbatim("n1"));
    expect(nodeEventLabel("n1", undefined)).toEqual(verbatim("n1"));
  });

  it("reads the root step as 'root' when id and name are both null", () => {
    expect(nodeEventLabel(null, null)).toEqual({ key: "events.nodeLabel.root" });
  });

  it("shows the name alone when the id is null but a name is present", () => {
    expect(nodeEventLabel(null, "workflow")).toEqual(verbatim("workflow"));
  });
});
