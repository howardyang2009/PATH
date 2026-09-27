# The run entry options are two arms: a launch and a continuation

**Status:** accepted. Enforces the input rule of
[ADR 0003](0003-context-seed-path-for-path-run.md) and
[ADR 0046](0046-launch-facts-are-frozen-with-the-run.md) — input is identity-defining, so a
continuation carries none.

`RunOptions` was one flat bag of sixteen optional fields, and which of them were legal depended on
the mode. The rule lived in the callers: `continuationRunOptions` stripped `rerunFromRunId` and
forced `operatorInput: undefined`, declaring `operatorInput?: undefined` on its own result type so
that builder could not put one back, and `project-resume` destructured it out. Nothing stopped a
direct caller from writing `{ continuation: { kind: "resume", … }, operatorInput: X }`, and
`runWorkflow` would have acted on it wrongly: `buildLaunchFacts` reads `options.operatorInput`, a
Resume's `reentry()` is `undefined`, so the successor root would record `launchFacts` carrying an
input override the run never applied. Two call sites stood between the type and the bug.

The engine already had the better shape next door: `cli/parse-run.ts` models the same three
invocations — launch, resume, list-eligible — as a closed arm union with `undefined` fields, so
"illegal flag combinations are unconstructable", and it builds the flat bag only after the arm is
known. The engine's own entry point had not adopted that discipline.

## Decision

1. **`RunOptions` is a union of two arms.** `RunSeams` holds what both accept (`input`,
   `operatorConfig`, `files`, `observer`, `warn`, `workerOverrides`, `launchWorkerDefaults`,
   `registry`, `stepPluginsDir`, `processorConcurrency`, `signal`, `sourceWorkflowPath`).
2. **`operatorInput` lives on the launch arm only.** `LaunchRunOptions.operatorInput?: JsonValue`;
   `ContinuationRunOptions.operatorInput?: undefined`. A launch's input override is the one fact the
   successor's recorded launch facts must never claim.
3. **The continuation's own facts stay off a launch.** `unresolvedLaunchSecrets` and
   `inheritedLaunchSecretKeys` are real fields on `ContinuationRunOptions` and `undefined` on
   `LaunchRunOptions`.
4. **`continuation` discriminates.** Required on the continuation arm, `undefined` on the launch arm,
   so a truthiness test narrows the union.
5. **`Project` mirrors the split.** `ProjectLaunchOptions`, `ProjectContinuationOptions`,
   `ProjectResumeOptions` (the continuation arm plus the rerun boundary K, ADR 0032), and
   `ProjectRunOptions` as either arm. `ProjectExecOptions` is an arm plus the continuation the run
   assembly built, which is what `execute` receives.
6. **The refusals are pinned by a compile-time test.** `test/run-options.test.ts` uses
   `@ts-expect-error`, so the build fails if `{ continuation, operatorInput }` or a launch's
   `unresolvedLaunchSecrets` ever starts typechecking again.

## Considered Options

- **Two arms** (chosen). The type states the rule the docs already stated, and no launch call site
  changes.
- **Keep the bag and trust the two callers.** Rejected. The type admitted a state the engine acts on
  wrongly, and a third caller would not have known.
- **Three entry functions (`runWorkflow` / `resumeWorkflow` / `completeWorkflow`).** Rejected for
  now. It duplicates the run assembly that `runWorkflow` owns behind one seam, and the continuation
  object is what already distinguishes the modes.
- **A `mode` discriminant field.** Rejected. It invents a field the engine never reads and breaks
  every launch call site that passes none.

## Consequences

- **A new mode-specific field must declare both arms.** That is the point: the compiler asks which
  modes it is legal in.
- **`Project.resume` and `Project.complete` cannot receive an operator input**, and a caller that
  builds one options object for launch and resume states only the shared seams
  (`ProjectSharedOptions`), as the CLI does.
- **`run-workflow` re-exports both arms** so a host can name what it builds; `@path/engine`'s index
  exports them with the rest of the entry vocabulary.
- **The behavioural rule is unchanged.** This records no new fact about runs; it makes an existing
  one unrepresentable to break.
