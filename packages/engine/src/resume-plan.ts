import {
  findRootRun,
  isStepType,
  rerunBoundaryIndex,
  rerunDisposition,
  serialOrder,
  walkNodes,
  type JsonValue,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";
import { planReuse, type ReusePlan } from "./plan-reuse.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import type { ResumeInput } from "./run-workflow.js";

/**
 * The **Resume plan**: how each scope of a successor tree resumes against the predecessor (#172,
 * ADR 0001/0035/0036/0037/0054/0062), owned in one module.
 *
 * A successor walks the current file and, at every scope it opens — the root run, a nested
 * `workflow` run, a `while-do` iteration container, a goto pass — asks the same two questions: which
 * recorded row of the predecessor answers this scope (its **counterpart**), and which of its children
 * reuse (the **reuse plan**, with the Resume-from-K boundary suppressed out of it). Each scope kind
 * used to answer them itself: its own counterpart lookup, its own ambiguity rule, and its own slice of
 * two parallel boundary arrays. Here each scope kind is one `enter…` operation over one
 * {@link RunResume}, and the boundary is one list of `{nodeId, pass}` levels.
 *
 * The interface is the test surface: every operation is pure over `RunRecord[]` rows and a file, so a
 * pairing or boundary rule is testable without a store.
 */

/** One level of the Resume-from-K descent path (ADR 0036): the path-node's id and the goto pass it sits in (ADR 0054 §6). */
export interface RerunPathLevel {
  nodeId: string;
  /** The 1-based goto pass the path-node sits in at this level, or `null` for a level whose file holds no goto. */
  pass: number | null;
}

/**
 * What a scope carries into its workflow-run before its file is known: the whole-tree read inputs,
 * this scope's own **counterpart** (undefined = added since, run fresh), and the remaining rerun path
 * from this level down (`[]` = off-path / plain Resume). {@link resolveResume} turns it into a
 * {@link RunResume} once the run's file is in hand.
 */
export interface ResumeEntry {
  input: ResumeInput;
  counterpart: RunRecord | undefined;
  rerunPath: RerunPathLevel[];
}

/** One scope's resume state: its entry plus the reuse plan for its direct children. */
export interface RunResume extends ResumeEntry {
  /** Node ids of this scope's direct children that reuse, each pointing at the original run it reuses. */
  plan: ReusePlan;
}

/** Which recorded row answers a scope: under one parent, by node id, iteration ordinal, or pass ordinal. */
export interface RecordedScopeKey {
  nodeId?: string | null;
  iteration?: number;
  pass?: number;
  /** Only a `succeeded` row answers (a reusable iteration). */
  succeeded?: boolean;
}

/**
 * The **one** recorded row under `parentRunId` that answers `key`, or `undefined`. Exactly one match
 * answers; zero (added since) or more than one (which attempt is undefined) both answer none, so the
 * scope runs fresh rather than guessing. Resume and Complete both look rows up through here.
 */
export function recordedChild(
  rows: readonly RunRecord[],
  parentRunId: string | undefined,
  key: RecordedScopeKey,
): RunRecord | undefined {
  if (parentRunId === undefined) return undefined;
  const matches = rows.filter(
    (r) =>
      r.parentRunId === parentRunId &&
      (key.nodeId === undefined || r.nodeId === key.nodeId) &&
      (key.iteration === undefined || r.iteration === key.iteration) &&
      (key.pass === undefined || r.pass === key.pass) &&
      (!key.succeeded || r.status === "succeeded"),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The root run's entry: its counterpart is the predecessor tree's own root run, and it carries the
 * whole rerun path. `Project.resume` validated that path against this file already.
 */
export function rootResumeEntry(input: ResumeInput): ResumeEntry {
  const nodePath = input.rerunFromNodePath ?? [];
  const passes = input.rerunFromPasses ?? [];
  return {
    input,
    counterpart: findRootRun(input.originalRuns),
    rerunPath: nodePath.map((nodeId, level) => ({ nodeId, pass: passes[level] ?? null })),
  };
}

/**
 * Producer A (ADR 0035): this level's **suppress** set — the boundary head B and every
 * serialized-later run-producing node id, over this file's own serial order (ADR 0064: a sequence body
 * is transparent). `undefined` off-path / plain Resume.
 */
function suppressSet(file: WorkflowFile, rerunPath: readonly RerunPathLevel[]): Set<string> | undefined {
  const bIndex = rerunBoundaryIndex(file.body, suffixOf(rerunPath));
  if (bIndex === undefined) return undefined;
  const suppress = new Set<string>();
  for (const node of walkNodes(serialOrder(file.body).slice(bIndex))) {
    if (isStepType(node.type)) suppress.add(node.id);
  }
  return suppress;
}

function suffixOf(rerunPath: readonly RerunPathLevel[]): string[] {
  return rerunPath.map((level) => level.nodeId);
}

/**
 * A scope's resume state once its file is known: the reuse plan scoped to its counterpart's children,
 * with this level's boundary suppressed (B and after re-run). No counterpart plans nothing.
 */
export function resolveResume(entry: ResumeEntry, file: WorkflowFile): RunResume {
  const { counterpart } = entry;
  return {
    ...entry,
    plan: counterpart
      ? planReuse(entry.input.originalRuns, file, counterpart.runId, suppressSet(file, entry.rerunPath))
      : new Map(),
  };
}

/**
 * The context seed a resumed **root** run replays from (ADR 0062): the counterpart's recorded
 * `input.json`, never its final `context.json`, which under Resume-from-K would leak keys written after
 * K. `undefined` for a nested run (its own interpolated input already is its seed, secrets real) and
 * for a root with no counterpart (a first attempt seeds fresh).
 */
export function resumeSeed(entry: ResumeEntry | undefined, isRoot: boolean): { [key: string]: JsonValue } | undefined {
  if (!entry?.counterpart || !isRoot) return undefined;
  return entry.input.readBlob(entry.counterpart, RUN_BLOB_FILE.input) as { [key: string]: JsonValue };
}

/**
 * The entry a nested `workflow` node's run inherits (Producer B, ADR 0036), from this level's own
 * boundary disposition:
 *
 * - **descend** — the node is this level's intermediate path-node B: re-enter its counterpart and hand
 *   it the path's tail, so it reuses its inner prefix and applies its own boundary one level down.
 * - **rerun-entire** — the node is after B, or is K itself: no counterpart, the whole subtree re-runs.
 * - **reuse / off-path** — re-enter the counterpart exactly as plain Resume, with no path.
 *
 * `undefined` when this run is not resuming.
 */
export function enterNested(resume: RunResume | undefined, file: WorkflowFile, nodeId: string): ResumeEntry | undefined {
  if (!resume) return undefined;
  const disposition = rerunDisposition(file.body, suffixOf(resume.rerunPath), nodeId);
  const counterpart =
    disposition === "rerun-entire" ? undefined : recordedChild(resume.input.originalRuns, resume.counterpart?.runId, { nodeId });
  return { input: resume.input, counterpart, rerunPath: disposition === "descend" ? resume.rerunPath.slice(1) : [] };
}

/**
 * The resume state for one `while-do` iteration container (ADR 0037), or `undefined` to run it fresh.
 * An iteration reuses only when the loop is in this level's reuse region (K at or after it re-runs the
 * whole loop) and the counterpart holds a **succeeded** container with this ordinal. The container's
 * plan is scoped to it, whose only run-producing child is the loop body, so the body reuses whole.
 */
export function enterIteration(
  resume: RunResume | undefined,
  file: WorkflowFile,
  nodeId: string,
  iteration: number,
): RunResume | undefined {
  if (!resume?.counterpart) return undefined;
  if (rerunDisposition(file.body, suffixOf(resume.rerunPath), nodeId) !== "reuse") return undefined;
  const counterpart = recordedChild(resume.input.originalRuns, resume.counterpart.runId, { nodeId, iteration, succeeded: true });
  if (!counterpart) return undefined;
  return resolveResume({ input: resume.input, counterpart, rerunPath: [] }, file);
}

/**
 * The resume state for each goto **pass** of one resuming workflow-run (ADR 0054 §5–6, spec
 * docs/spec/goto.md §8.1), in walk order. A pass pairs with the predecessor's pass holding the same
 * ordinal **and** opened by the same goto (`null` for pass 1), whatever its status, and plans reuse
 * inside it: a failed pass reuses its succeeded nodes and re-runs from the failure. The first pass
 * that finds no partner leaves the record, so it and every later pass run fresh — the returned
 * function holds that pairing state.
 *
 * Resume-from-K at this level names the pass N its boundary B sits in: passes before N pair as plain
 * Resume, pass N applies the boundary inside it, and every pass after N runs fresh. A boundary with no
 * pass (a goto added since) pairs nothing, since pairing without the boundary would silently reuse
 * the work the operator asked to drop.
 */
export function passResumer(resume: RunResume, file: WorkflowFile): (pass: number, openerId: string | null) => RunResume {
  const fresh: RunResume = { input: resume.input, counterpart: undefined, rerunPath: [], plan: new Map() };
  const head = resume.rerunPath[0];
  const boundaryPass = head ? head.pass : undefined;
  let paired = head === undefined || typeof boundaryPass === "number";
  return (pass, openerId) => {
    if (!paired || (typeof boundaryPass === "number" && pass > boundaryPass)) return fresh;
    const counterpart = recordedChild(resume.input.originalRuns, resume.counterpart?.runId, { pass, nodeId: openerId });
    if (!counterpart) {
      paired = false;
      return fresh;
    }
    return resolveResume({ input: resume.input, counterpart, rerunPath: pass === boundaryPass ? resume.rerunPath : [] }, file);
  };
}
