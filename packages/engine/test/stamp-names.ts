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

/**
 * Refuse a node still written in the deleted `@1` container shape (#282, `@2` §4.3).
 *
 * These stampers take `unknown` and cast their way to a `WorkflowFile`, so a fixture built through
 * them is the one container-slot population nothing checks: `tsc` never sees the literal and the
 * schema never parses it. Left unguarded, an `@1` slot reaches the executor as a tree it cannot run
 * — an arm with no `node`, a `while-do` with no body, a branch that is not a node — and fails deep
 * inside dispatch instead of saying which fixture is stale. Every refusal names the node.
 */
function refuseLegacyShape(node: AnyNode): void {
  const where = typeof node.name === "string" ? node.name : typeof node.id === "string" ? node.id : "<unnamed>";
  const refuse = (message: string): never => {
    throw new Error(`${where}: @1 ${message} — migrate the fixture to @2 (workflow-format-v2.md §4.3, #282)`);
  };

  if (Array.isArray(node.branches)) {
    // The `@1` wrapper `{ id, name, body }` was not itself a node; in `@2` a branch *is* one.
    for (const branch of node.branches) {
      const b = branch as AnyNode;
      if (typeof b?.type !== "string") refuse("`{id, name, body}` branch wrapper in `parallel.branches` — a branch is a node");
    }
  }
  if (Array.isArray(node.arms)) {
    for (const arm of node.arms) {
      const a = arm as AnyNode;
      if (a?.body !== undefined) refuse("`body` array on a branch arm — an arm holds a single `node`");
      // An arm with neither is the same stale fixture one key further along: unguarded it reaches
      // the executor and fails there, which is exactly what this guard exists to pre-empt.
      if (a?.node === undefined) refuse("branch arm carrying no occupant — an arm holds a single `node`");
    }
  }
  if (Array.isArray(node.else)) refuse("bare-array `else` — the `else` occupant is a single node");
  if (node.type === "while-do" && node.body !== undefined) {
    refuse("`body` array on a `while-do` — the loop body is a single `node`");
  }
}

function stampNode(node: AnyNode): AnyNode {
  refuseLegacyShape(node);
  const stamped: AnyNode = { ...node };
  if (typeof stamped.id === "string" && stamped.name === undefined) stamped.name = stamped.id;
  // `@2`: each branch *is* a node (stampNode recurses its own body/children).
  if (Array.isArray(stamped.branches)) {
    stamped.branches = stamped.branches.map((b) => stampNode(b as AnyNode));
  }
  if (Array.isArray(stamped.arms)) {
    // `@2`: an arm's occupant is a single `node` (not a `body` array).
    stamped.arms = stamped.arms.map((arm) => {
      const a = arm as AnyNode;
      return a.node ? { ...a, node: stampNode(a.node as AnyNode) } : a;
    });
  }
  // `@2`: `else` and a `while-do`'s body are single nodes.
  if (stamped.else) stamped.else = stampNode(stamped.else as AnyNode);
  if (stamped.node) stamped.node = stampNode(stamped.node as AnyNode);
  if (Array.isArray(stamped.body)) stamped.body = stampNodes(stamped.body as AnyNode[]);
  return stamped;
}

export function stampNodes(nodes: unknown): WorkflowNode[] {
  return (nodes as AnyNode[]).map(stampNode) as unknown as WorkflowNode[];
}

/** Stamp `name = id` throughout a workflow file's body and bump `format` to `path/workflow@2`. */
export function stampNames(file: unknown): WorkflowFile {
  const f = { ...(file as AnyNode) };
  f.format = "path/workflow@2";
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
  refuseLegacyShape(node);
  const stamped: AnyNode = { ...node };
  if (stamped.name === undefined && typeof stamped.id === "string") stamped.name = stamped.id;
  stamped.id = randomUUID();
  // `@2`: each branch is a node; an arm/`else`/`while-do` body is a single `node` (§4.3).
  if (Array.isArray(stamped.branches)) {
    stamped.branches = stamped.branches.map((b) => guidNode(b as AnyNode));
  }
  if (Array.isArray(stamped.arms)) {
    stamped.arms = stamped.arms.map((arm) => {
      const a = arm as AnyNode;
      return a.node ? { ...a, node: guidNode(a.node as AnyNode) } : a;
    });
  }
  if (stamped.else) stamped.else = guidNode(stamped.else as AnyNode);
  if (stamped.node) stamped.node = guidNode(stamped.node as AnyNode);
  if (Array.isArray(stamped.body)) stamped.body = (stamped.body as AnyNode[]).map(guidNode);
  return stamped;
}

export function stampGuids(file: unknown): WorkflowFile {
  const f = { ...(file as AnyNode) };
  f.format = "path/workflow@2";
  f.id = randomUUID(); // always a real GUID — this is the schema-valid stamper
  if (Array.isArray(f.body)) f.body = (f.body as AnyNode[]).map(guidNode);
  return f as unknown as WorkflowFile;
}
