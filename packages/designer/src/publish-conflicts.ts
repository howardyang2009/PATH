import { childBodies, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";

/**
 * The publish-conflict detector behind the pane's context-write concession (#370, designer-spec
 * § Context reads and writes). Context is invisible plumbing — a read is an ordinary `${context.x}`
 * interpolation, a write is a step's `publish` pane field — never drawn structure. The one concession to
 * visibility is a **publish conflict the load-time checks reject**, which the canvas surfaces as a **node
 * validation marker**, because it is a load error the author must see.
 *
 * The two rejected conflicts (workflow-format-v0.md §10, CONTEXT.md § Publish set) are:
 * 1. a **`collect` same-key sibling race** — two concurrent parallel branches (of a `collect` or
 *    `do-not-wait` join, i.e. any join but `wait-one`) that both publish one key; and
 * 2. a **publish inside a `do-not-wait` branch** — a fire-and-forget branch runs past the join and may
 *    not publish at all.
 *
 * These mirror `workflow-file.ts`'s load-time refinements exactly, re-expressed as a **node-id → message**
 * map the canvas can mark: the race marks the offending branch node (a later sibling that repeats a key),
 * the do-not-wait violation marks each publishing node below the detached branch.
 */

/** A node's `publish` map keys — the context keys it writes — or `[]` when it carries no publish set. */
export function publishKeysOf(node: WorkflowNode): string[] {
  const publish = (node as { publish?: unknown }).publish;
  return publish !== null && typeof publish === "object" ? Object.keys(publish as Record<string, unknown>) : [];
}

/** Every publish key anywhere in a subtree — a branch's whole publish set, for the sibling-race check. */
function subtreePublishKeys(node: WorkflowNode): Set<string> {
  const keys = new Set<string>();
  for (const descendant of walkNodes([node])) {
    for (const key of publishKeysOf(descendant)) keys.add(key);
  }
  return keys;
}

/** Mark a node, keeping the first message when a node already carries one. */
function mark(marks: Map<string, string>, id: string, message: string): void {
  if (!marks.has(id)) marks.set(id, message);
}

/**
 * The `collect` same-key sibling race: for every parallel whose join lands more than the winner (any
 * join but `wait-one`), a key two concurrent branches both publish is a last-writer race. The later
 * branch to repeat the key is the one marked, matching the load-time refinement's offender.
 */
function collectRaces(file: WorkflowFile, marks: Map<string, string>): void {
  for (const node of walkNodes(file.body)) {
    if (node.type !== "parallel" || node.join === "wait-one") continue;
    const seen = new Map<string, string>();
    for (const branch of node.branches) {
      for (const key of subtreePublishKeys(branch)) {
        if (seen.has(key)) {
          mark(marks, branch.id, `publishes "${key}", already published by a sibling branch — a collect join would race`);
        } else {
          seen.set(key, branch.id);
        }
      }
    }
  }
}

/**
 * A publish anywhere inside a `do-not-wait` branch. The `insideDoNotWait` latch turns on once a
 * `do-not-wait` parallel is entered, so a publish nested in a `collect`/`while-do`/`branch` under the
 * detached branch is caught too (do-not-wait-join.md §4).
 */
function doNotWaitPublishes(nodes: WorkflowNode[], insideDoNotWait: boolean, marks: Map<string, string>): void {
  for (const node of nodes) {
    if (insideDoNotWait) {
      const keys = publishKeysOf(node);
      if (keys.length > 0) {
        mark(marks, node.id, `publishes inside a do-not-wait branch — a fire-and-forget branch runs past the join and may not publish`);
      }
    }
    const detached = insideDoNotWait || (node.type === "parallel" && node.join === "do-not-wait");
    for (const child of childBodies(node)) doNotWaitPublishes(child.nodes, detached, marks);
  }
}

/** The node ids that carry a publish conflict, each mapped to the marker message the canvas shows. */
export function publishConflicts(file: WorkflowFile): Map<string, string> {
  const marks = new Map<string, string>();
  collectRaces(file, marks);
  doNotWaitPublishes(file.body, false, marks);
  return marks;
}
