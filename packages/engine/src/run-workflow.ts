import { randomUUID } from "node:crypto";
import { findRootRun, type WorkflowFile } from "@path/schema";
import { rootCancellation } from "./cancellation.js";
import {
  type Continuation,
  completeContinuation,
  noContinuation,
  resolveRerunFromNodePath,
  resumeContinuation,
} from "./continuation.js";
import { buildLaunchFacts } from "./launch-facts.js";
import { createProcessorSemaphore, DEFAULT_PROCESSOR_CONCURRENCY } from "./processor-semaphore.js";
import type { EnvSource } from "./resolve-env.js";
import { rootResumeEntry } from "./resume-plan.js";
import type { Emit, RunIdentity } from "./run-context.js";
import { createEmitter } from "./run-emitter.js";
import { executeWorkflowRun } from "./run-node.js";
import type { RunOptions, RunResult } from "./run-options.js";
import { analyzeRunStart, resolveExecutorRegistry } from "./run-start.js";
import { maskRunEvent } from "./secret-mask.js";

export { runNode, runSequence } from "./run-node.js";
export type {
  ContinuationInput,
  ContinuationRunOptions,
  ContinueInput,
  LaunchRunOptions,
  ResumeInput,
  RunOptions,
  RunResult,
  RunSeams,
  UserSecrets,
  WorkerOverrides,
} from "./run-options.js";

/** **The Run executor**: `runWorkflow` roots a run tree — one workflow-run per file, one node at a
 * time in order. */

/** Runs the top-level workflow as the root of a run tree (mvp spec §2, invariant 2). */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const continuationInput = options.continuation;
  const resumeInput = continuationInput?.kind === "resume" ? continuationInput : undefined;
  const completeInput = continuationInput?.kind === "complete" ? continuationInput : undefined;

  // A Complete keeps the tree's own root id; a launch or Resume takes the caller's or mints one.
  const runId = completeInput?.rootRunId ?? options.rootRunId ?? randomUUID();

  // One snapshot for the whole run, read here and nowhere else, so a mid-run env change cannot
  // desync the masker. User secrets replace the host environment entirely, never merge with it.
  const env: EnvSource = { ...(options.userSecrets ?? process.env) };

  // The load's scanned registry, or a folder scan for a caller with no load; `workerOverrides`
  // merge replace-only.
  const registry = await resolveExecutorRegistry(
    options.registry,
    options.workerOverrides,
    options.stepPluginsDir,
  );

  // The whole run-start config read behind one seam: collect, resolve `$env`, collect `$secret`,
  // gate (ADR 0022 sub-3).
  const { masker, runStartFailure } = analyzeRunStart(file, fileDir, options, env, registry);
  for (const warning of masker.warnings) options.warn?.(warning);

  // Assembled once from the same options the run executes with, so recorded facts and executed
  // config cannot drift.
  const launchFacts = buildLaunchFacts(
    {
      input: options.operatorInput,
      config: options.operatorConfig,
      workerDefaults: options.launchWorkerDefaults,
    },
    env,
    options.inheritedLaunchSecretKeys ?? [],
  );

  const { observer } = options;

  // The original tree's root run — the predecessor fact stamped on this fresh root's start.
  const originalRoot = findRootRun(resumeInput?.originalRuns ?? []);
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskRunEvent(masker, o));
      }
    : async () => {};

  // The tree's one masking sink becomes the root emitter; descendants get their own via
  // `emitter.child`.
  const rootIdentity: RunIdentity = {
    runId,
    rootRunId: runId,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
  };
  // The tree's root cancellation authority: the operator's signal is its only outside cause
  // (`cancellation.ts`).
  const rootAuthority = rootCancellation(options.signal);
  // The root's continuation: a Resume pairs with the original tree's root (ADR 0036); a Complete
  // re-enters this tree's root in place, skipping its start (ADR 0041); a launch records nothing.
  const continuation: Continuation = resumeInput
    ? resumeContinuation(rootResumeEntry(resumeInput), file, true)
    : completeInput
      ? completeContinuation(completeInput, file, runId)
      : noContinuation();
  let result: RunResult;
  try {
    result = await executeWorkflowRun({
      file,
      fileDir,
      input: options.input ?? {},
      incomingConfig: options.operatorConfig ?? {},
      identity: rootIdentity,
      files: options.files,
      emitter: createEmitter(rootIdentity, emit),
      env,
      runStartFailure,
      launchFacts,
      signal: rootAuthority.signal,
      cancellation: rootAuthority,
      // One registry and one semaphore for the whole run tree — the cap is engine-wide (mvp spec
      // §5.5).
      runtime: {
        registry,
        semaphore: createProcessorSemaphore(
          options.processorConcurrency ?? DEFAULT_PROCESSOR_CONCURRENCY,
        ),
        // The launch worker-default table is shared by the whole tree (ADR 0044).
        launchWorkerDefaults: options.launchWorkerDefaults,
      },
      continuation,
      // K's descent path, denormalized for the root row; undefined on plain Resume (ADR 0032).
      rerunFromNodePath: resumeInput
        ? resolveRerunFromNodePath(
            file,
            fileDir,
            options.files,
            resumeInput.rerunFromNodePath,
            resumeInput.rerunFromPasses,
          )
        : undefined,
      // This fresh root resumes the original tree, so its predecessor is that tree's root run id.
      resumedFromRootRunId: originalRoot?.runId,
      // Root-only provenance: the root file's store-relative path, recorded on the root row.
      sourceWorkflowPath: options.sourceWorkflowPath,
    });
  } catch (err) {
    // A worker that threw rather than returning `failed` (ADR 0020 sub-5): it is not caught into a
    // failed step, but its message may carry a config secret, so the masker scrubs it on the way
    // out.
    if (!masker.isEmpty && err instanceof Error) {
      err.message = masker.maskString(err.message);
    }
    throw err;
  }

  // What the caller gets back is masked too — everything except a *succeeded* run's `output`, which
  // is the run's product and prints as the pipeline's answer. `error` always: it carries text the
  // engine did not compose, and the CLI prints it into a CI log. A thrown bug escapes unscrubbed
  // (§8.3).
  if (masker.isEmpty) return result;
  return {
    ...result,
    ...(result.status === "succeeded" ? {} : { output: masker.maskValue(result.output) }),
    ...(result.error !== undefined ? { error: masker.maskString(result.error) } : {}),
  };
}
