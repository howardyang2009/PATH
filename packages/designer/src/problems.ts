import {
  tokenizeInterpolation,
  walkNodes,
  type Condition,
  type JsonValue,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { publishConflicts, publishKeysOf } from "./publish-conflicts.js";

/**
 * The whole-file cross-node validation pass behind the canvas validation-error UX (#388, designer-spec
 * § Canvas validation-error UX). The canvas already makes illegal *structure* unsnappable and the pane
 * refuses to commit a schema-invalid node edit, so the errors that survive to a whole-file view are
 * dominantly **cross-node** — a fact no single node can see:
 *
 * 1. a **publish conflict** the load-time checks reject (`publish-conflicts.ts`, #370);
 * 2. a **dangling `${context.…}` read** — an interpolation whose `context` key no step in the file
 *    publishes; and
 * 3. a **dangling condition path** — a `context.…` path in a branch/while/checkpoint condition whose
 *    key no step publishes.
 *
 * Only the **`context`** root is checked. Context is written from inside the run, so its keys are
 * statically knowable — the file's own publish sets (CONTEXT.md § Context / Publish set). `output` is a
 * predecessor's runtime output (author-trust, no static shape — ADR 0022 sub-7) and `config` is injected
 * from outside (inheritable, operator-overridable), so neither can be called dangling here, and flagging
 * them would be a false positive.
 *
 * These are **soft** errors: they do not block save (an author routinely writes a consumer before its
 * producer, and nested-ref create-new *requires* it). They surface as two coupled read-only derivations
 * of the file — a per-node marker (`problemMarks`) and the aggregate list this returns.
 */

/** Which cross-node check produced a problem, for the panel's grouping and the row's tint. */
export type ProblemKind = "publish-conflict" | "dangling-interpolation" | "dangling-condition";

/** One cross-node error, carrying the offending node's id + name so the panel can jump to it. */
export interface Problem {
  nodeId: string;
  nodeName: string;
  kind: ProblemKind;
  message: string;
}

/**
 * Every string leaf reachable from a value, tokenized for `${…}` placeholders — the concrete dot-paths
 * a value interpolates. Recurses into arrays and objects (an `input` object, a `publish` value); their
 * keys are data, not grammar, so nothing is skipped inside a value.
 */
function* placeholderPaths(value: JsonValue): Generator<string> {
  if (typeof value === "string") {
    for (const token of tokenizeInterpolation(value)) {
      if (token.kind === "placeholder") yield token.path;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* placeholderPaths(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* placeholderPaths(item);
  }
}

// The node keys that are **not** interpolable text: the non-interpolable envelope (`id`, `name`, `type`,
// `ref`, `worker`, `parse`) and the child-grammar keys (nested node bodies, walked separately; and
// conditions, scanned by `conditionPaths`). Every other key — `input`, `publish`, `config`,
// `max_iterations`, and a leaf type's own fields (`prompt`, `command`, …) — carries interpolable text.
const NON_INTERPOLABLE_KEYS = new Set([
  "id",
  "name",
  "type",
  "ref",
  "worker",
  "parse",
  "branches",
  "body",
  "node",
  "arms",
  "else",
  "condition",
  "when",
]);

/** Every `${…}` placeholder path in a node's own interpolable fields (not its nested child nodes). */
function nodePlaceholderPaths(node: WorkflowNode): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (NON_INTERPOLABLE_KEYS.has(key)) continue;
    for (const path of placeholderPaths(value as JsonValue)) paths.push(path);
  }
  return paths;
}

/** Every leaf `path` in a condition tree — the `all`/`any`/`not` combinators only compose others. */
function conditionPaths(condition: Condition): string[] {
  switch (condition.type) {
    case "all":
    case "any":
      return condition.of.flatMap(conditionPaths);
    case "not":
      return conditionPaths(condition.of);
    default:
      return [condition.path];
  }
}

/** The conditions a node carries directly: a `branch` arm's `when`, a `while-do`/`checkpoint` condition. */
function nodeConditions(node: WorkflowNode): Condition[] {
  switch (node.type) {
    case "branch":
      return node.arms.map((arm) => arm.when);
    case "while-do":
    case "checkpoint":
      return [node.condition];
    default:
      return [];
  }
}

/** The `context` key a `context.<key>…` dot-path reads, or `null` when the path is not context-rooted. */
function contextKey(path: string): string | null {
  const segments = path.split(".");
  return segments[0] === "context" && segments.length > 1 ? segments[1]! : null;
}

/**
 * The whole-file problem list, in document order (the panel's rows). Publish conflicts first for a
 * node, then its dangling reads, then its dangling condition paths; each dangling key reported once per
 * node per kind, so a key repeated in one node does not spam the panel.
 */
export function fileProblems(file: WorkflowFile): Problem[] {
  const published = new Set<string>();
  for (const node of walkNodes(file.body)) {
    for (const key of publishKeysOf(node)) published.add(key);
  }

  const conflicts = publishConflicts(file);
  const problems: Problem[] = [];

  for (const node of walkNodes(file.body)) {
    const conflict = conflicts.get(node.id);
    if (conflict) {
      problems.push({ nodeId: node.id, nodeName: node.name, kind: "publish-conflict", message: conflict });
    }

    const readSeen = new Set<string>();
    for (const path of nodePlaceholderPaths(node)) {
      const key = contextKey(path);
      if (key === null || published.has(key) || readSeen.has(key)) continue;
      readSeen.add(key);
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        kind: "dangling-interpolation",
        message: `reads \`\${context.${key}}\`, which no step in this file publishes`,
      });
    }

    const condSeen = new Set<string>();
    for (const condition of nodeConditions(node)) {
      for (const path of conditionPaths(condition)) {
        const key = contextKey(path);
        if (key === null || published.has(key) || condSeen.has(key)) continue;
        condSeen.add(key);
        problems.push({
          nodeId: node.id,
          nodeName: node.name,
          kind: "dangling-condition",
          message: `condition reads \`context.${key}\`, which no step in this file publishes`,
        });
      }
    }
  }

  return problems;
}

/**
 * The per-node marker map the canvas reads (`node-id → marker message`). A node with several problems
 * shows one marker whose title stacks its messages, so a collapsed marker still names every reason.
 */
export function problemMarks(problems: Problem[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const problem of problems) {
    const existing = marks.get(problem.nodeId);
    marks.set(problem.nodeId, existing ? `${existing}\n${problem.message}` : problem.message);
  }
  return marks;
}
