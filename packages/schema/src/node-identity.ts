import { IdSchema } from "./ids.js";
import type { WorkflowNode } from "./node-type.js";
import { childBodies, childNodePath } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/**
 * Node identity, stated once as **data**: the `id` an occurrence carries (the durable GUID Resume
 * matches a successor node on, ADR 0006) and the `name` it carries (the readable, file-unique label).
 *
 * **What this module exists to own.** Three doors enforce one rule, and each spelled it for itself:
 * the load refinement checked duplicate `name`s ("the GUID `id` is unique by construction, so only
 * `name` is checked here"), the write route re-walked the typed nodes to catch **internally duplicate**
 * `id`s (its own `collectIds`, whose comment admitted it was "mirroring `@path/schema`'s `collectNames`
 * walk"), and the Designer re-derived both over **raw JSON** before parsing, so it could name the
 * colliding nodes for an author. One rule, three implementations, kept equal by hand.
 *
 * Here the walk and the rule are one thing each:
 *
 * - {@link identityIssues} is the rule over **occurrences** a caller supplies, so an adapter that holds
 *   raw JSON (the Designer, pre-parse) and one that holds the parsed file feed the same predicate.
 * - {@link nodeIdentityOccurrences} is the typed walk, with the JSON paths the load refinement points
 *   its issues at.
 *
 * Wording deliberately stays with each door. The load refusal speaks zod, the write route speaks one
 * `error.details` line, and the Designer speaks an author-facing bullet list naming nodes by label —
 * three audiences, one verdict. What they share is the verdict: which occurrence offends, which one
 * already held the value, and under which rule.
 */

/** Which rule an issue came from — the taxonomy every door selects from. */
export type NodeIdentityRule =
  /** The same `name` on two nodes: names are unique across the file (workflow-format-v0.md §3). */
  | "duplicate-name"
  /** The same `id` on two occurrences: the reuse key must identify one node (ADR 0015). */
  | "duplicate-id"
  /** An `id` present but not a UUIDv4 — never rewritten, always refused (ADR 0015). */
  | "invalid-id";

/**
 * One place an identity value appears, as the caller can see it. An adapter over parsed nodes and one
 * over raw JSON both produce these; nothing here requires a schema-valid file, which is the point —
 * the Designer's identity gate runs *before* the parse.
 */
export interface IdentityOccurrence {
  /** The `id` value as written, or `undefined` when the occurrence carries none (repaired, not refused). */
  id?: unknown;
  /** The `name` value as written, or `undefined`. */
  name?: unknown;
  /**
   * The occurrence's own JSON path, as the caller spells it: `[]` for the workflow's own row,
   * `["body", 0]` for the first top-level node, `["body", 1, "arms", 0, "node"]` below a branch arm.
   * Each door appends the field it is talking about (`path` + `"id"`), because only it knows whether
   * its reader thinks in nodes or in fields.
   */
  path: (string | number)[];
}

/** One rejected identity, as data: the rule, the offending value, and the two paths a duplicate names. */
export interface NodeIdentityIssue {
  rule: NodeIdentityRule;
  /** The identity value the rule is about, exactly as written (a string when valid, anything when not). */
  value: unknown;
  /** The offending occurrence's path, as the caller supplied it. */
  path: (string | number)[];
  /** A duplicate only: the path of the occurrence that already held the value, first in caller order. */
  firstPath?: (string | number)[];
}

/**
 * Apply each requested `rule` to `occurrences`, in the order the rules are listed, returning one issue
 * per offence. Duplicates are grouped by value in first-seen order: the **first** occurrence in caller
 * order keeps the value, and every later holder is one issue naming it as `firstPath`. A walk in body
 * order therefore reports `body.0` as the holder and `body.1` as the offender — the reading a message
 * needs — and a reader that wants one line per colliding value (rather than per extra holder) groups
 * the issues by `value`, which is how the Designer names every node sharing one `id`.
 */
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

/**
 * Every node of a parsed file, depth-first in body order, each with its JSON path — the walk the load
 * refinement used to spell as `collectNames`. The descent is `childBodies`' (the block grammar's one
 * statement), so a control block kind added to the format is scanned here without a second edit.
 *
 * The workflow's own row is **not** included: {@link workflowIdentityOccurrence} is, so a door that
 * wants it in the namespace says so. The `name` namespace is the nodes' — that is the rule the load
 * refinement shipped — while the `id` namespace also holds the workflow's own GUID, because a node
 * reusing it collides exactly the way two nodes do (ADR 0015's write-door check).
 */
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
