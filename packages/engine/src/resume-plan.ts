import {
  findRootRun,
  isStepType,
  type JsonValue,
  type RunRecord,
  rerunBoundaryIndex,
  rerunDisposition,
  serialOrder,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import { planReuse, type ReusePlan, recordedChild } from "./plan-reuse.js";
import type { ResumeInput } from "./run-workflow.js";

/**
 * The **Resume plan**: how each scope of a successor tree resumes against the predecessor. Every scope
 * — root run, nested `workflow` run, `while-do` iteration, goto pass — asks which recorded row is its
 * **counterpart** and which children reuse (the **reuse plan**, boundary suppressed). Each scope kind is
 * one `enter…` operation over one {@link RunResume}, pure over rows and a file so rules are testable.
 */

/**
 * One level of the Resume-from-K descent path (ADR 0036): the path-node's id and the goto pass it sits in (ADR 0054
 * §6).
 */
export interface RerunPathLevel {
  nodeId: string;
  /** The 1-based goto pass the path-node sits in at this level, or `null` for a level whose file holds no goto. */
  pass: number | null;
}

/**
 * What a scope carries into its workflow-run before its file is known: the read inputs, its **counterpart**
 * (undefined = run fresh), and the remaining rerun path (`[]` = off-path).
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

/**
 * The root run's entry: its counterpart is the predecessor's root run, carrying the whole rerun path
 * (`Project.resume` already validated it).
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
 * Producer A (ADR 0035): this level's **suppress** set — the boundary head B and every serialized-later run-producing
 * node id, over this file's serial order (ADR 0064: a sequence body is transparent); `undefined` off-path.
 */
function suppressSet(
  file: WorkflowFile,
  rerunPath: readonly RerunPathLevel[],
): Set<string> | undefined {
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
 * A scope's resume state once its file is known: the reuse plan scoped to its counterpart's children, with this
 * level's boundary suppressed (B and after re-run); no counterpart plans nothing.
 */
export function resolveResume(entry: ResumeEntry, file: WorkflowFile): RunResume {
  const { counterpart } = entry;
  return {
    ...entry,
    plan: counterpart
      ? planReuse(
          entry.input.originalRuns,
          file,
          counterpart.runId,
          suppressSet(file, entry.rerunPath),
        )
      : new Map(),
  };
}

/**
 * The context seed a resumed **root** run replays from (ADR 0062): the counterpart's recorded `input.json`, never its
 * final `context.json`, which under Resume-from-K would leak keys written after K. `undefined` for a nested run (its
 * own interpolated input is its seed) or a root with no counterpart.
 */
export function resumeSeed(
  entry: ResumeEntry | undefined,
  isRoot: boolean,
): { [key: string]: JsonValue } | undefined {
  if (!entry?.counterpart || !isRoot) return undefined;
  return entry.input.readBlob(entry.counterpart, RUN_BLOB_FILE.input) as {
    [key: string]: JsonValue;
  };
}

/**
 * The entry a nested `workflow` node's run inherits (Producer B, ADR 0036): **descend** hands the
 * intermediate path-node's counterpart the path's tail; **rerun-entire** (the node is after B or is K)
 * plans no counterpart; **reuse / off-path** re-enters as plain Resume. `undefined` when not resuming.
 */
export function enterNested(
  resume: RunResume | undefined,
  file: WorkflowFile,
  nodeId: string,
): ResumeEntry | undefined {
  if (!resume) return undefined;
  const disposition = rerunDisposition(file.body, suffixOf(resume.rerunPath), nodeId);
  const counterpart =
    disposition === "rerun-entire"
      ? undefined
      : recordedChild(resume.input.originalRuns, resume.counterpart?.runId, { nodeId });
  return {
    input: resume.input,
    counterpart,
    rerunPath: disposition === "descend" ? resume.rerunPath.slice(1) : [],
  };
}

/**
 * The resume state for one `while-do` iteration (ADR 0037), or `undefined` to run it fresh: it reuses only when the
 * loop is in this level's reuse region and the counterpart holds a **succeeded** container with this ordinal.
 */
export function enterIteration(
  resume: RunResume | undefined,
  file: WorkflowFile,
  nodeId: string,
  iteration: number,
): RunResume | undefined {
  if (!resume?.counterpart) return undefined;
  if (rerunDisposition(file.body, suffixOf(resume.rerunPath), nodeId) !== "reuse") return undefined;
  const counterpart = recordedChild(resume.input.originalRuns, resume.counterpart.runId, {
    nodeId,
    iteration,
    succeeded: true,
  });
  if (!counterpart) return undefined;
  return resolveResume({ input: resume.input, counterpart, rerunPath: [] }, file);
}

/**
 * The resume state for each goto **pass** of one resuming workflow-run (ADR 0054 §5–6, goto spec §8.1),
 * in walk order: a pass pairs with the predecessor's pass of the same ordinal opened by the same goto
 * (`null` for pass 1), whatever its status. The first pass with no partner leaves the record, so it and
 * every later pass run fresh; under Resume-from-K, passes before the boundary pass N pair as plain
 * Resume and later ones run fresh. A boundary with no pass pairs nothing — pairing would reuse work the
 * operator asked to drop.
 */
export function passResumer(
  resume: RunResume,
  file: WorkflowFile,
): (pass: number, openerId: string | null) => RunResume {
  const fresh: RunResume = {
    input: resume.input,
    counterpart: undefined,
    rerunPath: [],
    plan: new Map(),
  };
  const head = resume.rerunPath[0];
  const boundaryPass = head ? head.pass : undefined;
  let paired = head === undefined || typeof boundaryPass === "number";
  return (pass, openerId) => {
    if (!paired || (typeof boundaryPass === "number" && pass > boundaryPass)) return fresh;
    const counterpart = recordedChild(resume.input.originalRuns, resume.counterpart?.runId, {
      pass,
      nodeId: openerId,
    });
    if (!counterpart) {
      paired = false;
      return fresh;
    }
    return resolveResume(
      {
        input: resume.input,
        counterpart,
        rerunPath: pass === boundaryPass ? resume.rerunPath : [],
      },
      file,
    );
  };
}

export { type RecordedScopeKey, recordedChild } from "./plan-reuse.js";
