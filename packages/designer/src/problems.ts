import {
  type Condition,
  type GotoIssueRule,
  gotoIssues,
  type JsonValue,
  publishKeysOf,
  publishSetIssues,
  tokenizeInterpolation,
  type WorkflowFile,
  type WorkflowNode,
  walkNodes,
} from "@path/schema";
import { resolveRefPath } from "./resolve-ref.js";

/**
 * The whole-file cross-node validation pass behind the canvas validation-error UX: publish conflicts,
 * dangling `context.…` reads in interpolations and conditions, dangling `workflow`-refs (a create-new
 * child is dangling until its first save), and refused gotos. Only the `context` root is checked — its
 * keys are statically knowable from the file's own publish sets, unlike `output` and `config`. These are
 * **soft** errors: they do not block save.
 */

/** Which cross-node check produced a problem, for the panel's grouping and the row's tint. */
export type ProblemKind =
  | "publish-conflict"
  | "dangling-interpolation"
  | "dangling-condition"
  | "dangling-ref"
  | GotoIssueRule;

/**
 * What the dangling-`workflow`-ref check needs beyond the file: the referring file's own path (a ref is
 * stored relative to its directory) and the set of discovered (saved) workflow paths.
 */
export interface RefLookup {
  filePath: string;
  knownPaths: ReadonlySet<string>;
}

/**
 * A `RefLookup` for a file, or `undefined` when the check must not run: no file path (nothing to resolve
 * a relative ref from), or discovery not yet loaded — an empty set would flag every saved ref dangling
 * for one frame.
 */
export function refLookupFor(
  filePath: string | null | undefined,
  knownPaths: ReadonlySet<string> | null,
): RefLookup | undefined {
  if (filePath == null || knownPaths === null) return undefined;
  return { filePath, knownPaths };
}

/** One cross-node error, carrying the offending node's id + name so the panel can jump to it. */
export interface Problem {
  nodeId: string;
  nodeName: string;
  kind: ProblemKind;
  message: string;
}

/** Every `${…}` placeholder dot-path in a value, recursing through arrays and objects (whose keys are data). */
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

// Node keys that are **not** interpolable text: the envelope (`id`, `name`, `type`, `ref`, `worker`,
// `parse`), the child-grammar keys, and conditions (scanned by `conditionPaths`).
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
 * The whole-file problem list, in document order: per node, publish conflicts, then dangling reads and
 * condition paths, each key reported once per node per kind.
 */
export function fileProblems(file: WorkflowFile, refs?: RefLookup): Problem[] {
  // The file's own `input` is the root context's default seed, so its top-level keys are readable before
  // any step publishes; a launch override may replace it and this pass cannot see that.
  const published = new Set<string>(Object.keys(file.input ?? {}));
  for (const node of walkNodes(file.body)) {
    for (const key of publishKeysOf(node)) published.add(key);
  }

  // The canvas projection of the load-time publish-set verdict (`publishSetIssues`): one issue per
  // offending node, first wins when a node carries more than one.
  const conflicts = new Map<string, string>();
  for (const issue of publishSetIssues(file)) {
    if (!conflicts.has(issue.nodeId)) conflicts.set(issue.nodeId, issue.message);
  }
  // The goto rule module's verdict, read the same way: one issue per offending goto, by its id.
  const gotos = new Map(gotoIssues(file).map((issue) => [issue.nodeId, issue]));
  const problems: Problem[] = [];

  for (const node of walkNodes(file.body)) {
    const conflict = conflicts.get(node.id);
    if (conflict) {
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        kind: "publish-conflict",
        message: conflict,
      });
    }
    const jump = gotos.get(node.id);
    if (jump)
      problems.push({
        nodeId: node.id,
        nodeName: node.name,
        kind: jump.rule,
        message: jump.message,
      });

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

    // A `workflow`-ref resolving outside the discovered files is dangling — a create-new child before
    // its first save, most often. An empty ref is a target-not-yet-chosen state, so it is left alone.
    if (refs && node.type === "workflow" && node.ref !== "") {
      const target = resolveRefPath(refs.filePath, node.ref);
      if (!refs.knownPaths.has(target)) {
        problems.push({
          nodeId: node.id,
          nodeName: node.name,
          kind: "dangling-ref",
          message: `references \`${node.ref}\`, which has no saved file yet`,
        });
      }
    }
  }

  return problems;
}

/**
 * The per-node marker map the canvas reads: a node with several problems gets one marker whose title
 * stacks its messages, so a collapsed marker still names every reason.
 */
export function problemMarks(problems: Problem[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const problem of problems) {
    const existing = marks.get(problem.nodeId);
    marks.set(problem.nodeId, existing ? `${existing}\n${problem.message}` : problem.message);
  }
  return marks;
}
