import { isPassRun, serialOrder, type GotoNode, type JsonValue, type RunRecord, type WorkflowFile } from "@path/schema";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import type { RunContext } from "./run-context.js";
import { passResumer, type RunResume } from "./resume-plan.js";

/**
 * The **goto pass** questions a file's top-level walk asks (ADR 0053/0054/0060, spec
 * docs/spec/goto.md §3, §8), answered in one module so the walk itself only jumps and emits.
 *
 * - Where does the walk start? Pass 1 at the top for a launch or a Resume; for a Complete, the one
 *   `running` pass it re-enters in place, with every recorded pass counted as a jump of the goto that
 *   opened it (ADR 0060). A running pass whose opening goto no longer targets the node it recorded
 *   first is a **divergence** the walk fails on.
 * - How does pass N resume? Through the Resume plan's pass pairing (`passResumer`).
 *
 * Both Continuation modes answer here, so a rule about a pass's first recorded node or its pairing
 * has one home.
 */

type WorkflowNode = WorkflowFile["body"][number];

/** Where a top-level walk with passes starts. */
export interface PassWalkStart {
  pass: number;
  /** The goto that opened the starting pass; `null` for pass 1. */
  opener: GotoNode | null;
  /** Index into the file's first level the starting pass runs from. */
  start: number;
  /** The starting pass's input: the walk's seed for pass 1, the recorded pass input on a re-entry. */
  carried: JsonValue;
  /** Jumps already spent per goto id (a Complete counts every recorded pass). */
  jumpsSpent: Map<string, number>;
  /** The recorded `running` pass a Complete re-enters in place (same id, no `run-started`). */
  reentered: RunRecord | undefined;
  /** The resume state for each pass as the walk opens it; `undefined` when the run is not resuming. */
  resumeFor: (pass: number, opener: GotoNode | null) => RunResume | undefined;
}

/** A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2). */
export interface PassDivergence {
  diverged: RunRecord;
  error: string;
}

/**
 * The node a pass opened at, as a run row records it: a goto target's first node in serial order
 * (ADR 0064), since a `sequence` records no row of its own.
 */
export function passFirstNode(target: WorkflowNode): WorkflowNode | undefined {
  return serialOrder([target])[0];
}

/**
 * The goto **pass** rows recorded under one workflow-run (ADR 0060), in ordinal order. A pass's
 * `nodeId` names the goto that opened it (null for pass 1), so these rows are also the jump counts.
 */
export function recordedPasses(rows: readonly RunRecord[], parentRunId: string): RunRecord[] {
  return rows.filter((r) => r.parentRunId === parentRunId && isPassRun(r)).sort((a, b) => a.pass! - b.pass!);
}

/**
 * The start of one workflow-run's top-level walk over a file holding gotos (`gotos` by id).
 */
export function passWalkStart(
  run: Pick<RunContext, "file" | "identity" | "resume" | "continue">,
  gotos: ReadonlyMap<string, GotoNode>,
  seedInput: JsonValue,
): PassWalkStart | PassDivergence {
  const resumer = run.resume && passResumer(run.resume, run.file);
  const walk: PassWalkStart = {
    pass: 1,
    opener: null,
    start: 0,
    carried: seedInput,
    jumpsSpent: new Map(),
    reentered: undefined,
    resumeFor: (pass, opener) => resumer?.(pass, opener?.id ?? null),
  };
  const state = run.continue;
  if (!state) return walk;

  // Complete (ADR 0060, spec §8.2): follow the record. Every recorded pass counts one jump for the goto
  // that opened it, and the walk re-enters the one `running` pass in place. Closed passes are facts,
  // not re-walked: no condition, goto or event of theirs is replayed.
  const passes = recordedPasses(state.existingRuns, run.identity.runId);
  for (const recorded of passes) {
    if (recorded.nodeId !== null) walk.jumpsSpent.set(recorded.nodeId, (walk.jumpsSpent.get(recorded.nodeId) ?? 0) + 1);
  }
  const reentered = passes.find((recorded) => recorded.status === "running");
  if (!reentered) return walk;
  walk.reentered = reentered;
  walk.pass = reentered.pass!;
  walk.carried = state.readBlob(reentered, RUN_BLOB_FILE.input);
  if (walk.pass === 1) return walk;

  // Pass N starts at its opening goto's target in the reloaded file, which must be the node the pass
  // recorded first; else the tail would no longer match the pass's rows. `existingRuns` is in start
  // order, so the first child row is the earliest.
  const body = run.file.body;
  const goto = reentered.nodeId === null ? undefined : gotos.get(reentered.nodeId);
  const target = goto && body.find((candidate) => candidate.name === goto.target);
  const recordedFirst = state.existingRuns.find((r) => r.parentRunId === reentered.runId);
  if (!goto || !target || passFirstNode(target)?.id !== recordedFirst?.nodeId) {
    return {
      diverged: reentered,
      error:
        `Complete replay diverged: pass ${walk.pass} was opened by goto "${goto?.name ?? reentered.nodeName}" ` +
        `whose target is now "${goto?.target ?? "(none)"}", recorded "${recordedFirst?.nodeName ?? "(none)"}"`,
    };
  }
  walk.opener = goto;
  walk.start = body.indexOf(target);
  return walk;
}
