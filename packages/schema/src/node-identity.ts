import { IdSchema } from "./ids.js";
import type { WorkflowNode } from "./node-type.js";
import { childBodies, childNodePath } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/** Node identity stated once as **data**: the `id` (the durable GUID Resume matches on, ADR 0006) and
 * the `name` (readable, file-unique). The load refinement, the write route and the Designer all read it. */

/** Which rule an issue came from — the taxonomy every door selects from. */
export type NodeIdentityRule = "duplicate-name" | "duplicate-id" | "invalid-id";

/** One place an identity value appears; adapters over parsed nodes and over raw JSON both produce these. */
export interface IdentityOccurrence {
  /** The `id` value as written, or `undefined` when the occurrence carries none (repaired, not refused). */
  id?: unknown;
  /** The `name` value as written, or `undefined`. */
  name?: unknown;
  /** The occurrence's own JSON path as the caller spells it (`[]` for the workflow row, `["body", 0]`
   * for the first node); each door appends the field it is talking about. */
  path: (string | number)[];
}

/** One rejected identity, as data: the rule, the offending value, and the two paths a duplicate names. */
export interface NodeIdentityIssue {
  rule: NodeIdentityRule;
  value: unknown;
  /** The offending occurrence's path, as the caller supplied it. */
  path: (string | number)[];
  /** A duplicate only: the path of the occurrence that already held the value, first in caller order. */
  firstPath?: (string | number)[];
}

/** Applies each requested `rule` to `occurrences` in rule order, one issue per offence. Duplicates are
 * grouped by value in first-seen order: the first holder keeps the value and every later holder names
 * it as `firstPath`, so a body-order walk reports `body.0` as holder and `body.1` as offender. */
export function identityIssues(
  occurrences: readonly IdentityOccurrence[],
  rules: readonly NodeIdentityRule[],
): NodeIdentityIssue[] {
  const issues: NodeIdentityIssue[] = [];

  for (const rule of rules) {
    if (rule === "invalid-id") {
      for (const occurrence of occurrences) {
        // Absent is repaired, present-but-invalid is refused (ADR 0015): only the second is an issue.
        if (occurrence.id === undefined) continue;
        if (!IdSchema.safeParse(occurrence.id).success) {
          issues.push({ rule, value: occurrence.id, path: occurrence.path });
        }
      }
      continue;
    }

    const field = rule === "duplicate-name" ? "name" : "id";
    const holders = new Map<unknown, (string | number)[][]>();
    for (const occurrence of occurrences) {
      const value = occurrence[field];
      if (value === undefined) continue;
      const paths = holders.get(value) ?? [];
      paths.push(occurrence.path);
      holders.set(value, paths);
    }
    for (const [value, paths] of holders) {
      for (const path of paths.slice(1)) {
        issues.push({ rule, value, path, firstPath: paths[0]! });
      }
    }
  }

  return issues;
}

/** Every node of a parsed file, depth-first in body order, each with its JSON path; the workflow's own
 * row is not included, and the `id` namespace also holds the workflow's GUID (ADR 0015). */
export function nodeIdentityOccurrences(file: WorkflowFile): IdentityOccurrence[] {
  const occurrences: IdentityOccurrence[] = [];

  const collect = (node: WorkflowNode, path: (string | number)[]): void => {
    occurrences.push({
      id: (node as { id?: unknown }).id,
      name: (node as { name?: unknown }).name,
      path,
    });
    for (const child of childBodies(node)) {
      child.nodes.forEach((each, index) => {
        collect(each, [...path, ...childNodePath(child, index)]);
      });
    }
  };

  file.body.forEach((node, index) => {
    collect(node, ["body", index]);
  });
  return occurrences;
}

/** The workflow's own row, for a door whose namespace includes it — the root of the `id` namespace. */
export function workflowIdentityOccurrence(file: WorkflowFile): IdentityOccurrence {
  return { id: (file as { id?: unknown }).id, name: (file as { name?: unknown }).name, path: [] };
}

/** The typed convenience: the nodes' identity issues, with no workflow row in either namespace. */
export function nodeIdentityIssues(
  file: WorkflowFile,
  rules: readonly NodeIdentityRule[],
): NodeIdentityIssue[] {
  return identityIssues(nodeIdentityOccurrences(file), rules);
}
