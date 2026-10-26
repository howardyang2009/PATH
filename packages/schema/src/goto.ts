import type { Message } from "@path/i18n";
import { codedMessage } from "./coded-issue.js";
import type { GotoNode, WorkflowNode } from "./node-type.js";
import { childBodies, childNodePath, walkNodes } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/** The **goto** load refusals as **data** (docs/spec/goto.md §2.3): the load refinement turns each
 * issue into a zod issue at its JSON path, and the Designer projects the same issues onto node ids.
 * File-scoped on purpose — "first level" is per file, so a Step-Template body is never checked
 * here. */

/** Which refusal an issue came from. There is no other case. */
export type GotoIssueRule = "target-absent" | "target-inner" | "target-self" | "placement";

/** One refused goto, as data: the rule, the goto's own id, the load path, and the wording. */
export interface GotoIssue {
  rule: GotoIssueRule;
  /** The offending goto's durable `id` (ADR 0015). */
  nodeId: string;
  /** The goto node itself for `placement`; its `target` field for the three target rules. */
  path: (string | number)[];
  message: Message;
}

/** Every refused goto in a file body, in document order. A misplaced goto is reported as
 * `placement` only, its target not also judged; a clean or goto-free file yields `[]`. */
export function gotoIssues(file: WorkflowFile): GotoIssue[] {
  const firstLevel = new Set(file.body.map((node) => node.name));
  const everyName = new Set([...walkNodes(file.body)].map((node) => node.name));
  const issues: GotoIssue[] = [];

  // `barrier` is the nearest enclosing `while-do` / `parallel`, the only ancestors a goto may not
  // have (§2.2): a jump out of an iteration or a concurrent branch has no single place to land.
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
      message: Message,
    ): GotoIssue[] => [{ rule, nodeId: node.id, path, message }];
    if (barrier) {
      return issue(
        "placement",
        nodePath,
        codedMessage("schema.goto.placement", {
          name: node.name,
          barrierType: barrier.type,
          barrier: barrier.name,
        }),
      );
    }
    const targetPath = [...nodePath, "target"];
    if (node.target === node.name)
      return issue(
        "target-self",
        targetPath,
        codedMessage("schema.goto.target-self", { name: node.name }),
      );
    if (firstLevel.has(node.target)) return [];
    if (everyName.has(node.target)) {
      return issue(
        "target-inner",
        targetPath,
        codedMessage("schema.goto.target-inner", { target: node.target }),
      );
    }
    return issue(
      "target-absent",
      targetPath,
      codedMessage("goto.target-not-found", { target: node.target }),
    );
  };

  file.body.forEach((node, index) => {
    visit(node, ["body", index], undefined);
  });
  return issues;
}
