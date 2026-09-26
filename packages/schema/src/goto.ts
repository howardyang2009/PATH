import type { GotoNode, WorkflowNode } from "./node-type.js";
import { childBodies, childNodePath, walkNodes } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/**
 * The **goto** load refusals, stated once as **data** (docs/spec/goto.md §2.3, ADR 0056/0058), in the
 * `publish-set.ts` pattern: the load refinement (`workflow-file.ts`) turns each issue into a zod issue
 * at its JSON path, and the Designer's problem pass can project the same issues onto node ids.
 *
 * File-scoped on purpose: "first level" is per file, so a Step-Template body — which has no file
 * namespace until it lands — is never checked here (`makeBodySchema` does not call this). The instance
 * is checked by the target file's load instead.
 */

/** Which refusal an issue came from. There is no other case. */
export type GotoIssueRule = "target-absent" | "target-inner" | "target-self" | "placement";

/** One refused goto, as data: the rule, the goto's own id, the load path, and the wording. */
export interface GotoIssue {
  rule: GotoIssueRule;
  /** The offending goto's durable `id` (ADR 0015). */
  nodeId: string;
  /** The goto node itself for `placement`; its `target` field for the three target rules. */
  path: (string | number)[];
  message: string;
}

/**
 * Every refused goto in a file body, in document order, one issue per offender. A misplaced goto is
 * reported as `placement` only: its target is not also judged. A clean or goto-free file yields `[]`.
 */
export function gotoIssues(file: WorkflowFile): GotoIssue[] {
  const firstLevel = new Set(file.body.map((node) => node.name));
  const everyName = new Set([...walkNodes(file.body)].map((node) => node.name));
  const issues: GotoIssue[] = [];

  // `barrier` is the nearest enclosing `while-do` / `parallel`, the only ancestors a goto may not have
  // (§2.2): a jump out of an iteration or a concurrent branch has no single place to land.
  const visit = (
    node: WorkflowNode,
    nodePath: (string | number)[],
    barrier: WorkflowNode | undefined,
  ): void => {
    if (node.type === "goto") issues.push(...issuesFor(node, nodePath, barrier));
    const inner = node.type === "while-do" || node.type === "parallel" ? node : barrier;
    for (const child of childBodies(node)) {
      child.nodes.forEach((each, index) => {
        visit(each, [...nodePath, ...childNodePath(child, index)], inner);
      });
    }
  };

  const issuesFor = (
    node: GotoNode,
    nodePath: (string | number)[],
    barrier: WorkflowNode | undefined,
  ): GotoIssue[] => {
    const issue = (
      rule: GotoIssueRule,
      path: (string | number)[],
      message: string,
    ): GotoIssue[] => [{ rule, nodeId: node.id, path, message }];
    if (barrier) {
      return issue(
        "placement",
        nodePath,
        `goto "${node.name}" may not sit under ${barrier.type} "${barrier.name}"`,
      );
    }
    const targetPath = [...nodePath, "target"];
    if (node.target === node.name)
      return issue("target-self", targetPath, `goto "${node.name}" targets itself`);
    if (firstLevel.has(node.target)) return [];
    if (everyName.has(node.target)) {
      return issue(
        "target-inner",
        targetPath,
        `goto target "${node.target}" is not a first-level node`,
      );
    }
    return issue(
      "target-absent",
      targetPath,
      `goto target "${node.target}" not found in this file`,
    );
  };

  file.body.forEach((node, index) => {
    visit(node, ["body", index], undefined);
  });
  return issues;
}
