import type { WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { findAwaitingNode } from "../src/awaiting-node.js";

/**
 * A workflow file whose `body` is the given raw nodes. `person-activity` is a plugin leaf type
 * outside the core node union, so the nodes are cast in — exactly as a structurally-parsed file
 * carries them (the Viewer parses raw JSON, never the registry-validated shape).
 */
function file(body: unknown[]): WorkflowFile {
  return {
    format: "path/workflow@3",
    id: "wf-1",
    name: "wf",
    body: body as WorkflowFile["body"],
  };
}

const personNode = {
  id: "legal-signoff",
  type: "person-activity",
  name: "legal-signoff",
  description: "Review the contract for {{client.name}}.",
  assignee: "legal@acme.co",
  outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
};

describe("findAwaitingNode", () => {
  it("returns the person-activity node's fields by id, description left as authored", () => {
    const found = findAwaitingNode(file([personNode]), "legal-signoff");
    expect(found).toEqual({
      description: "Review the contract for {{client.name}}.",
      assignee: "legal@acme.co",
      outputSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
    });
  });

  it("finds a node nested inside a control block", () => {
    const wf = file([{ id: "seq", type: "sequence", name: "seq", body: [personNode] }]);
    expect(findAwaitingNode(wf, "legal-signoff")?.assignee).toBe("legal@acme.co");
  });

  it("returns null for an unknown id", () => {
    expect(findAwaitingNode(file([personNode]), "nope")).toBeNull();
  });

  it("returns null when the id maps to a non-person-activity node", () => {
    const wf = file([{ id: "draft", type: "prompt", name: "draft" }]);
    expect(findAwaitingNode(wf, "draft")).toBeNull();
  });

  it("normalises optional fields to null and a non-object outputSchema to null", () => {
    const bare = { id: "ask", type: "person-activity", name: "ask", description: "Do the thing." };
    const found = findAwaitingNode(file([bare]), "ask");
    expect(found).toEqual({ description: "Do the thing.", assignee: null, outputSchema: null });
  });
});
