import { randomUUID } from "node:crypto";
import type { JsonValue } from "@path/schema";
import type { RunResume } from "./resume-plan.js";
import type { RunContext, RunIdentity } from "./run-context.js";
import type { RunOutcome } from "./run-observer.js";

/**
 * **Child runs**: every run a workflow-run opens beneath itself — a nested `workflow` step's run, a
 * `while-do` iteration container (ADR 0037) and a goto pass container (ADR 0054).
 *
 * Each one answers the same three questions, and this module is where they are answered once:
 *
 * - **Which id?** A fresh one, or — when a Complete replay reached a row still `running` in this tree —
 *   that row's own id, re-entered in place (ADR 0041).
 * - **Does it start?** A fresh run emits `run-started`; a re-entered one already has its row, so a
 *   second `run-started` would insert a duplicate.
 * - **Does it finish?** A run whose walk parked at an awaiting leaf stays `running` (ADR 0038/0041): no
 *   `run-finished`. The caller simply does not call `finish` for an `awaiting` outcome.
 */

/** What identifies a child run beside its parent: the node that owns it, and its ordinal if it is a container. */
export interface ChildRunKey {
  /** The owning node (a `workflow` step, a `while-do`, a pass's opening goto), or `null` for goto pass 1. */
  owner: { id: string; name: string } | null;
  /** A `while-do` iteration's 1-based ordinal (ADR 0037). */
  iteration?: number;
  /** A goto pass's 1-based ordinal (ADR 0054). */
  pass?: number;
}

/**
 * The identity of a run opened under `parent`. `existingRunId` re-enters a recorded `running` row in
 * place (ADR 0041); without it the run is fresh and mints its own id.
 */
export function childIdentity(
  parent: RunIdentity,
  key: ChildRunKey,
  existingRunId?: string,
): RunIdentity {
  const identity: RunIdentity = {
    runId: existingRunId ?? randomUUID(),
    rootRunId: parent.rootRunId,
    parentRunId: parent.runId,
    nodeId: key.owner?.id ?? null,
    nodeName: key.owner?.name ?? null,
  };
  if (key.iteration !== undefined) identity.iteration = key.iteration;
  if (key.pass !== undefined) identity.pass = key.pass;
  return identity;
}

/** An opened container run: the context its body walks under, and the door that closes it. */
export interface ContainerRun {
  /** The parent's context with this container's identity, emitter and resume state swapped in. */
  run: RunContext;
  /** `true` for a freshly started container, `false` for a re-entered one (no `run-started` was emitted). */
  started: boolean;
  /** Emit this container's `run-finished`. Not called for an `awaiting` outcome — the container stays `running`. */
  finish(outcome: RunOutcome): Promise<void>;
}

/**
 * Open a container run — a `while-do` iteration or a goto pass — under `parent`. A container shares its
 * parent's file, config, environment and context blackboard; it only gives its body's runs a unique
 * parent scope, which is what lets a completed loop or pass be reused across Resume.
 */
export async function openContainerRun(
  parent: RunContext,
  args: {
    key: ChildRunKey;
    /** The recorded `running` row a Complete re-enters in place; `undefined` for a fresh container. */
    existingRunId: string | undefined;
    /** The container's input, recorded on its `run-started`. Unused for a re-entered container. */
    input: JsonValue;
    /** The Resume state for the container's body; `undefined` when the run is not resuming. */
    resume: RunResume | undefined;
  },
): Promise<ContainerRun> {
  const identity = childIdentity(parent.identity, args.key, args.existingRunId);
  const emitter = parent.emitter.child(identity);
  const started = args.existingRunId === undefined;
  if (started) await emitter.runStarted({ input: args.input });
  return {
    run: { ...parent, identity, emitter, resume: args.resume },
    started,
    finish: (outcome) => emitter.runFinished(outcome),
  };
}
