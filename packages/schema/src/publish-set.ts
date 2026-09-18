import { childBodies, walkNodes } from "./node-walk.js";
import type { WorkflowNode } from "./node-type.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/**
 * The **publish set**'s two load-time rejections, stated once as **data** (CONTEXT.md § Publish set,
 * workflow-format-v0.md §10). One walk answers both readers this module exists for:
 *
 * - the **load refinement** (`workflow-file.ts`) turns each issue into a zod issue at its JSON path,
 *   so the file is refused; and
 * - the **Designer's whole-file problem pass** (`@path/designer`'s `problems.ts`) projects the same
 *   issues onto node ids for the canvas marker and the launch warning count.
 *
 * The two rules used to be written twice: once over parsed nodes, emitting only dot-paths, and once in
 * the Designer over typed nodes, emitting only node ids — kept equal by hand. A rule change in one left
 * the canvas silent and launch unblocked while the load still refused the file.
 */

/** Which rejection an issue came from. */
export type PublishSetIssueRule = "sibling-race" | "detached-publish";

/** One rejected publish, as data: the rule, the offending node, the load path, and the wording. */
export interface PublishSetIssue {
  rule: PublishSetIssueRule;
  /** The offending node's durable `id` — the same GUID the canvas and the run rows carry (ADR 0015). */
  nodeId: string;
  /** The JSON path the load refinement points its issue at: the offending branch, or the publish key. */
  path: (string | number)[];
  /**
   * The load-time wording, so the canvas marker and the load refusal say the same thing about the same
   * file rather than paraphrasing each other.
   */
  message: string;
}

/**
 * A node's `publish` map keys — the context keys it writes — or `[]` when it carries no publish set.
 * Detected by presence, not a built-in-type allowlist, so a plugin leaf step's publishes fall under the
 * same guards (ADR 0018/0021) and the read-roots suggestion sees them too.
 */
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

// Publish keys are static strings, so a race between two *concurrent* sibling branches writing one
// context key is detectable — and rejected — at load time. A `collect` join lands every branch, so two
// writes to one key are a last-writer race; `wait-one` lands only the winner's, so the same key is
// deterministic there (wait-one-join.md §4.1) and the block's branches are still descended into. The
// walk follows nested control blocks but not a `workflow` step's ref'd file, which has its own isolated
// context (`childBodies` does not descend there).
function siblingRaceIssues(file: WorkflowFile): PublishSetIssue[] {
  const issues: PublishSetIssue[] = [];

  const walk = (nodes: WorkflowNode[], basePath: (string | number)[]): void => {
    nodes.forEach((node, index) => {
      const nodePath = [...basePath, index];
      const raceAllowed = node.type === "parallel" && node.join === "wait-one";

      // Only *concurrent* siblings can race: branch arms are alternatives (one runs) and while-do
      // iterations are sequential, so neither collides with itself — `concurrent` is the rule.
      const firstSeenIn = new Map<string, number>();
      childBodies(node).forEach((child, childIndex) => {
        if (child.concurrent && !raceAllowed) {
          // A concurrent slot is a `parallel` branch — exactly one node (`@2` §4.3), and the schema
          // requires the branch list non-empty. A hand-built empty slot races nothing.
          const branch = child.nodes[0];
          if (branch) {
            for (const key of new Set(subtreePublishKeys(branch))) {
              if (firstSeenIn.has(key)) {
                // `child.path` already lands on the branch node itself (`["branches", i]`, `@2` §4.3),
                // so the collision points at the offending branch directly — no trailing segment.
                issues.push({
                  rule: "sibling-race",
                  nodeId: branch.id,
                  path: [...nodePath, ...child.path],
                  message: `duplicate publish key "${key}": sibling parallel branches must not publish the same context key`,
                });
              } else {
                firstSeenIn.set(key, childIndex);
              }
            }
          }
        }
        walk(child.nodes, [...nodePath, ...child.path]);
      });
    });
  };

  walk(file.body, ["body"]);
  return issues;
}

// A `do-not-wait` branch is fire-and-forget: it runs past the join and lands after its would-be
// readers, so a `publish` from it is a nondeterministic write-after-read into shared context. A load
// error, not a silent runtime drop (do-not-wait-join.md §4). `insideDoNotWait` latches on once a
// detached block is entered, so a publish anywhere below it — including one nested in a
// `collect`/`while-do`/`branch` inside the detached branch — is caught (§4 "anywhere inside").
function detachedPublishIssues(file: WorkflowFile): PublishSetIssue[] {
  const issues: PublishSetIssue[] = [];

  const walk = (nodes: WorkflowNode[], basePath: (string | number)[], insideDoNotWait: boolean): void => {
    nodes.forEach((node, index) => {
      const nodePath = [...basePath, index];
      if (insideDoNotWait) {
        for (const key of publishKeysOf(node)) {
          issues.push({
            rule: "detached-publish",
            nodeId: node.id,
            path: [...nodePath, "publish", key],
            message: `publish "${key}" inside a do-not-wait branch: a fire-and-forget branch runs past the join and may not publish (do-not-wait-join.md §4)`,
          });
        }
      }
      const detached = insideDoNotWait || (node.type === "parallel" && node.join === "do-not-wait");
      for (const child of childBodies(node)) {
        walk(child.nodes, [...nodePath, ...child.path], detached);
      }
    });
  };

  walk(file.body, ["body"], false);
  return issues;
}

/**
 * Every rejected publish in a file body, in document order: the sibling races first for a given node's
 * walk position, then the detached-branch publishes. A clean file yields `[]`.
 */
export function publishSetIssues(file: WorkflowFile): PublishSetIssue[] {
  return [...siblingRaceIssues(file), ...detachedPublishIssues(file)];
}
