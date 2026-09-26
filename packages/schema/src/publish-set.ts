import type { WorkflowNode } from "./node-type.js";
import { childBodies, childNodePath, walkNodes } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/**
 * The publish set's two load-time rejections, stated once as data (CONTEXT.md § Publish set,
 * docs/format/workflow-format.md §5.1): the `workflow-file.ts` load refinement turns each issue into a zod issue
 * at its JSON path, and the Designer's problem pass projects the same issues onto node ids.
 */

export type PublishSetIssueRule = "sibling-race" | "detached-publish";

/** One rejected publish, as data: the rule, the offending node, the load path, and the wording. */
export interface PublishSetIssue {
  rule: PublishSetIssueRule;
  nodeId: string;
  path: (string | number)[];
  message: string;
}

/**
 * A node's `publish` map keys, or `[]`; detected by presence, so a plugin leaf step's publishes fall under the same
 * guards.
 */
export function publishKeysOf(node: WorkflowNode): string[] {
  const publish = (node as { publish?: unknown }).publish;
  return publish !== null && typeof publish === "object"
    ? Object.keys(publish as Record<string, unknown>)
    : [];
}

/** Every publish key anywhere in a subtree — a branch's whole publish set, for the sibling-race check. */
function subtreePublishKeys(node: WorkflowNode): Set<string> {
  const keys = new Set<string>();
  for (const descendant of walkNodes([node])) {
    for (const key of publishKeysOf(descendant)) keys.add(key);
  }
  return keys;
}

// Publish keys are static strings, so a race between two *concurrent* siblings writing one key is
// detectable at load. `collect` lands every branch (last-writer race); `wait-one` lands only the
// winner's, so the same key is deterministic there (wait-one-join.md §4.1). A `workflow` ref is not descended.
function siblingRaceIssues(file: WorkflowFile): PublishSetIssue[] {
  const issues: PublishSetIssue[] = [];

  const visit = (node: WorkflowNode, nodePath: (string | number)[]): void => {
    const raceAllowed = node.type === "parallel" && node.join === "wait-one";

    // Only *concurrent* siblings can race: branch arms are alternatives and while-do iterations are sequential.
    const firstSeenIn = new Set<string>();
    for (const child of childBodies(node)) {
      child.nodes.forEach((each, index) => {
        const childPath = [...nodePath, ...childNodePath(child, index)];
        if (child.concurrent && !raceAllowed) {
          for (const key of subtreePublishKeys(each)) {
            if (!firstSeenIn.has(key)) {
              firstSeenIn.add(key);
              continue;
            }
            issues.push({
              rule: "sibling-race",
              nodeId: each.id,
              path: childPath,
              message: `duplicate publish key "${key}": sibling parallel branches must not publish the same context key`,
            });
          }
        }
        visit(each, childPath);
      });
    }
  };

  file.body.forEach((node, index) => {
    visit(node, ["body", index]);
  });
  return issues;
}

// A `do-not-wait` branch is fire-and-forget: it lands after its would-be readers, so a `publish` from it
// is a nondeterministic write-after-read into shared context (do-not-wait-join.md §4). The latch catches a
// publish anywhere below the detached block, including one nested in a collect/while-do/branch inside it.
function detachedPublishIssues(file: WorkflowFile): PublishSetIssue[] {
  const issues: PublishSetIssue[] = [];

  const visit = (
    node: WorkflowNode,
    nodePath: (string | number)[],
    insideDoNotWait: boolean,
  ): void => {
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
      child.nodes.forEach((each, index) => {
        visit(each, [...nodePath, ...childNodePath(child, index)], detached);
      });
    }
  };

  file.body.forEach((node, index) => {
    visit(node, ["body", index], false);
  });
  return issues;
}

/**
 * Every rejected publish in a file body, in document order: the sibling races first, then the detached-branch
 * publishes.
 */
export function publishSetIssues(file: WorkflowFile): PublishSetIssue[] {
  return [...siblingRaceIssues(file), ...detachedPublishIssues(file)];
}
