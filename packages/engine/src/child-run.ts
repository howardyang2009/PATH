import { randomUUID } from "node:crypto";
import type { JsonValue } from "@path/schema";
import type { RunResume } from "./resume-plan.js";
import type { RunContext, RunIdentity } from "./run-context.js";
import type { RunOutcome } from "./run-observer.js";

/**
 * Child runs a workflow-run opens beneath itself: a nested `workflow` step, a `while-do` iteration
 * container or a goto pass container, re-entered in place when a Complete replay finds a `running` row.
 */

/** What identifies a child run beside its parent: the node that owns it, and its ordinal if it is a container. */
export interface ChildRunKey {
  /** The owning node, or `null` for goto pass 1. */
  owner: { id: string; name: string } | null;
  iteration?: number;
  pass?: number;
}

/** The identity of a run opened under `parent`; `existingRunId` re-enters a recorded `running` row in place. */
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
  run: RunContext;
  /** `true` for a fresh container, `false` for a re-entered one (no `run-started` was emitted). */
  started: boolean;
  /** Emit this container's `run-finished`. Not called for an `awaiting` outcome — the container stays `running`. */
  finish(outcome: RunOutcome): Promise<void>;
}

/** Open a container run under `parent`: a shared file/config/context, but a unique parent scope for its body. */
export async function openContainerRun(
  parent: RunContext,
  args: {
    key: ChildRunKey;
    existingRunId: string | undefined;
    input: JsonValue;
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
