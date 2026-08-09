/**
 * Test helper for the identity migration (ADR 0006/0007, #204).
 *
 * The engine's runtime reads a node's human `name` (output keys, log narration, error messages) and
 * its GUID `id` (audit `node_id`, reuse key) as two distinct fields. Unit tests that build a
 * `WorkflowFile` or a node array *inline* — bypassing the schema, which is the only thing that would
 * otherwise force both fields — historically wrote a single human `id`. Rather than restate every
 * literal with a UUID `id` plus a `name`, these helpers stamp `name = id` (and leave the human `id`
 * in place, which the runtime never validates as a UUID). Assertions that named a node by its old
 * `id` keep passing, because that value is now also its `name` and its audit `node_id`.
 *
 * Disk-loaded fixtures are migrated to real GUIDs + names by the codemod, so the id-vs-name
 * distinction is exercised for real there; these helpers cover only the inline-construction tests.
 */
import { randomUUID } from "node:crypto";
import type { WorkflowFile, WorkflowNode } from "@path/schema";

type AnyNode = { [key: string]: unknown };

function stampNode(node: AnyNode): AnyNode {
  const stamped: AnyNode = { ...node };
  if (typeof stamped.id === "string" && stamped.name === undefined) stamped.name = stamped.id;
  if (Array.isArray(stamped.branches)) {
    stamped.branches = stamped.branches.map((b) => {
      const branch = stampNode(b as AnyNode);
      if (Array.isArray(branch.body)) branch.body = stampNodes(branch.body as AnyNode[]);
      return branch;
    });
  }
  if (Array.isArray(stamped.arms)) {
    stamped.arms = stamped.arms.map((arm) => {
      const a = arm as AnyNode;
      return Array.isArray(a.body) ? { ...a, body: stampNodes(a.body as AnyNode[]) } : a;
    });
  }
  if (Array.isArray(stamped.else)) stamped.else = stampNodes(stamped.else as AnyNode[]);
  if (Array.isArray(stamped.body)) stamped.body = stampNodes(stamped.body as AnyNode[]);
  return stamped;
}

export function stampNodes(nodes: unknown): WorkflowNode[] {
  return (nodes as AnyNode[]).map(stampNode) as unknown as WorkflowNode[];
}

/** Stamp `name = id` throughout a workflow file's body and bump `format` to `path/workflow@1`. */
export function stampNames(file: unknown): WorkflowFile {
  const f = { ...(file as AnyNode) };
  f.format = "path/workflow@1";
  if (f.id === undefined) f.id = "wf-id"; // a placeholder GUID stand-in; runWorkflow never validates it
  if (Array.isArray(f.body)) f.body = stampNodes(f.body as AnyNode[]);
  return f as unknown as WorkflowFile;
}

/**
 * Like `stampNames`, but produces a file that passes the *real* schema (`parseWorkflowFile`): the old
 * human `id` moves to `name` and a fresh UUID replaces it on the workflow and every node/branch — the
 * shape the codemod produces. Use for tests that assert the schema itself accepts/rejects a file.
 */
function guidNode(node: AnyNode): AnyNode {
  const stamped: AnyNode = { ...node };
  if (stamped.name === undefined && typeof stamped.id === "string") stamped.name = stamped.id;
  stamped.id = randomUUID();
  if (Array.isArray(stamped.branches)) {
    stamped.branches = stamped.branches.map((b) => {
      const branch = guidNode(b as AnyNode);
      if (Array.isArray(branch.body)) branch.body = (branch.body as AnyNode[]).map(guidNode);
      return branch;
    });
  }
  if (Array.isArray(stamped.arms)) {
    stamped.arms = stamped.arms.map((arm) => {
      const a = arm as AnyNode;
      return Array.isArray(a.body) ? { ...a, body: (a.body as AnyNode[]).map(guidNode) } : a;
    });
  }
  if (Array.isArray(stamped.else)) stamped.else = (stamped.else as AnyNode[]).map(guidNode);
  if (Array.isArray(stamped.body)) stamped.body = (stamped.body as AnyNode[]).map(guidNode);
  return stamped;
}

export function stampGuids(file: unknown): WorkflowFile {
  const f = { ...(file as AnyNode) };
  f.format = "path/workflow@1";
  f.id = randomUUID(); // always a real GUID — this is the schema-valid stamper
  if (Array.isArray(f.body)) f.body = (f.body as AnyNode[]).map(guidNode);
  return f as unknown as WorkflowFile;
}
