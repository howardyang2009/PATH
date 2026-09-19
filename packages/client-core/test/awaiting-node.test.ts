import type { RunStatus, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { awaitingNodeForRun, findAwaitingNode } from "../src/awaiting-node.js";

/**
 * A workflow file whose `body` is the given raw nodes. `person-activity` is a plugin leaf type
 * outside the core node union, so the nodes are cast in — exactly as a structurally-parsed file
 * carries them (the Viewer parses raw JSON, never the registry-validated shape).
 */
function file(body: unknown[]): WorkflowFile {
  return {
    format: "path/workflow@4",
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

describe("awaitingNodeForRun", () => {
  const wf = file([personNode]);
  const run = (over: { status?: RunStatus; nodeId?: string | null } = {}) => ({
    status: "awaiting" as RunStatus,
    nodeId: "legal-signoff" as string | null,
    ...over,
  });

  it("resolves the node for an awaiting run naming it", () => {
    expect(awaitingNodeForRun(wf, run())?.assignee).toBe("legal@acme.co");
  });

  it("returns null for a non-awaiting run, a null file, or a run with no node id", () => {
    expect(awaitingNodeForRun(wf, run({ status: "running" }))).toBeNull();
    expect(awaitingNodeForRun(null, run())).toBeNull();
    expect(awaitingNodeForRun(wf, run({ nodeId: null }))).toBeNull();
  });

  it("scans a set of files and resolves a node that lives in a nested one, not only the root", () => {
    const root = file([{ id: "step-sub", type: "workflow", name: "sub", ref: "sub.workflow.json" }]);
    const sub = file([{ id: "nested", type: "person-activity", name: "nested", description: "Nested.", assignee: "ops@acme.co" }]);
    // The node id is defined in the sub-file; the array form finds it wherever it sits.
    expect(awaitingNodeForRun([root, sub], run({ nodeId: "nested" }))?.assignee).toBe("ops@acme.co");
    // Root-only cannot resolve it — the caller then degrades to the schema-less submit.
    expect(awaitingNodeForRun([root], run({ nodeId: "nested" }))).toBeNull();
    // An empty set resolves nothing.
    expect(awaitingNodeForRun([], run({ nodeId: "nested" }))).toBeNull();
  });
});
