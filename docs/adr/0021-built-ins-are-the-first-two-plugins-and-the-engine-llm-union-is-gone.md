# The built-ins are the first two plugins, and the `engine | llm` worker union is gone

**Status:** accepted; the built-in-migration decision of map
[#308](https://github.com/howardyang2009/PATH/issues/308), resolving
[#319](https://github.com/howardyang2009/PATH/issues/319) and folding in
[#327](https://github.com/howardyang2009/PATH/issues/327). Builds on the
[#309](https://github.com/howardyang2009/PATH/issues/309) keystone (a Worker is a named `run` method
per step type, no worker inheritance), the [#313](https://github.com/howardyang2009/PATH/issues/313)
resolution (the `StepRequest`/`StepResult` seam and one-lookup dispatch), and
[ADR 0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) (a plugin is a folder
under `packages/engine/step-plugins/`, built-ins included). ADR 0019 sub-decision 10 forecast this
ticket; nothing here amends 0019.

ADR 0019 fixed *where* `binary` and `prompt` live (folders) and *that* they are discovered. #309 fixed
*what* a Worker is (a named method) and #313 fixed the *seam* one implements. None of them removed the
old `engine | llm` worker schema, moved `model`/`options` off the worker, migrated the workflow files
that still carry `worker: {type: llm, …}`, or corrected `CONTEXT.md`. That is this ADR.

Decision: **`binary` and `prompt` become folders under `packages/engine/step-plugins/`, each shipping
exactly one worker; the `engine | llm` worker union and the `worker.ts`/`worker-type.ts` schema are
deleted; the `worker` field becomes an optional worker-*name* string; `model` and `options` move to
config; and the workflow format bumps to `path/workflow@3` with a codemod that refuses every case it
cannot rewrite without guessing.** No shipped step type carries more than one worker: `prompt`'s
`cli`/`remote` are named by #309 but unbuilt, and multi-worker *selection* is proven by a schema unit
test, not by a shipped plugin.

## The fifteen pinned sub-decisions

### The two built-in folders

1. **`binary` ships one worker named `spawn`.** The name is the method it performs
   (`child_process.spawn`), which is what a Worker now is (#309). The venue words the old union used —
   `engine`, `local`, `process` — are exactly the axis #309 removed, so they are not candidates.
   `default` is not a worker name; it is what `defaultWorker` points at (#313 sub-15), and pushing it
   into the author-visible namespace was already rejected there. `binary`'s `defaultWorker` is
   `"spawn"`, so nearly every workflow writes no `worker` field at all.

2. **`prompt` ships one worker named `sdk`, `defaultWorker: "sdk"`.** #309's model names `sdk` / `cli` /
   `remote`, but only `sdk` exists in code — `agent-sdk-worker.ts` itself records "no headless-CLI
   fallback is built (§7)". Building `cli` and `remote` is new feature work, out of scope for a
   migration. They are recorded as **named but unbuilt**: a future folder adds each as a second worker
   with no schema change. The issue text is corrected so it stops promising three shipped workers.

3. **No shipped step type has more than one worker, and none needs to.** The dispatch is one map
   lookup, `plugin.workers[node.worker ?? plugin.defaultWorker]`, identical whether a type has one
   worker or five — there is no code path that appears only at two. The `z.enum` gaining a second
   member is zod's behaviour, not PATH's. So multi-worker **selection** is proven by a unit test against
   `makeWorkflowFileSchema` with a fabricated two-worker registry entry (a valid name passes, an unknown
   name fails with the names listed, an absent name resolves to the default) — no shipped plugin, no
   test-only folder under the one scanned location (ADR 0019 sub-7). An earlier draft invented an `echo`
   type to host this proof; it was dropped because `binary` with `command: "cat"` already does what
   `echo` would, so the type existed only to carry a demonstration a unit test carries for free.

   The honest limit, recorded rather than discovered: the **capability-flag** path
   (`needsProcessorSlot`) is exercised by exactly one shipped worker, `sdk`. No shipped worker sets
   `meters` without also being the only worker of its type, and none sets a flag beside a flagless peer.
   That is coverage a future metering plugin extends; it is not a hole this ADR can fill without
   inventing a type, which sub-decision 3 just declined.

4. **The files move, they are not copied.** `src/binary-worker.ts` becomes `step-plugins/binary/index.ts`;
   `src/llm/agent-sdk-worker.ts` becomes `step-plugins/prompt/index.ts`;
   `src/llm/render-prompt-message.ts` becomes `step-plugins/prompt/render-prompt-message.ts`;
   `src/llm/llm-worker.ts` is **deleted** (its `PromptRequest`/`PromptResult`/`LlmWorker` types are
   replaced wholesale by the #313 seam's `StepRequest`/`StepResult`/`WorkerDescriptor`);
   `src/llm/processor-semaphore.ts` moves up to `src/processor-semaphore.ts`. The `src/llm/` directory
   disappears.

5. **The semaphore stays engine-side; the `prompt` folder only *declares* it needs a slot.** #313
   sub-5 gives the engine the acquire, because the concurrency cap is a capability the engine reads and
   masking is a choke point the engine owns. So `prompt`'s `sdk` worker sets
   `needsProcessorSlot: true` in its descriptor and holds no semaphore of its own. `binary`'s `spawn`
   sets nothing and stays uncapped, exactly as documented.

6. **Both workers rewrite against the public subpath, importing `z`, `defineStepPlugin`, `StepRequest`
   and `StepResult` from `@path/engine/plugin`** (ADR 0019 sub-5), as a third-party plugin does. This is
   the load-bearing point of ADR 0019 sub-10: the shipped built-ins prove the public surface adequate on
   every load. The engine additionally exports `resolveAgainstWorkflowDir(cwd, relative)` from that
   subpath — #313 sub-14's promised anchor helper — and `binary`'s worker is its first consumer,
   resolving its own `cwd` field against `request.cwd`.

7. **Neither worker names the step in its own errors.** #313 sub-9 has the engine add one uniform
   `step "<name>": ` prefix. Today both workers build their own — `prompt step "<name>"` in
   `agent-sdk-worker.ts`, `step "<name>" exited with code N` in `binary-worker.ts` — and
   `ResolvedBinaryStep.name` exists only to carry it. All of that goes: the messages become
   `failed to start "git": <reason>` and `exited with code 1: <tail>`, and `ResolvedBinaryStep.name` is
   deleted. The stderr-tail `.slice(-500)` stays inside the `binary` worker; it is that worker's
   formatting, not engine policy.

### The schema deletion and the data move

8. **`worker.ts` and `worker-type.ts` are deleted, and `worker` becomes an optional name string.** The
   `WorkerSchema` discriminated union, the `Worker`/`EngineWorker`/`LlmWorker` types, and their exports
   from `@path/schema`'s index all go. In `commonStepFields` (ADR 0018, as amended by #313 sub-12) the
   `worker` member is built per step type by the schema factory as a `z.enum` of that type's worker
   names — not a shared `WorkerSchema`. A step naming a worker its type does not have fails at load with
   the valid names listed.

9. **`model` and `options` move to config, pinned here.** #309 put both on config; this ADR fixes the
   keys as `config.model` and `config.options`. Two consequences the keystone did not cost, recorded:

   - **`model` loses interpolation against context.** Config is literal (`@3` §8), so a model chosen
     from a predecessor's output is no longer expressible. The common case survives unharmed — one
     `config.model` at the file top inherits to every prompt, and a per-step override is a step-level
     `config`. No workflow in the repo derives a model from context. Reinstating it later means making
     `model` a *field*, which is additive.
   - **`options` in config gains masking.** ADR 0020 sub-2 makes `$secret`/`$env` representable in config
     only, and `collectSecrets` walks config. An MCP server credential inside `options` is therefore
     maskable as `config.options`, which it was not as a worker-side bag.

10. **`prompt`'s load-time required-`model` check regresses to a run-time check, accepted.** `model` was
    required on `LlmWorkerSchema`, so a `prompt` step with no model failed at *load*. As `config.model`
    it fails at *run* — config is a free-form map with no per-key required declaration (`@3` §8) — by
    which point the run row exists and the step has started. This is accepted, not fixed here: giving
    `sdk` a default model would silently spend on a model the author never named (the same harm the
    codemod refuses, sub-decision 12), and inventing a required-config-key mechanism is
    [#320](https://github.com/howardyang2009/PATH/issues/320)'s to design. The regression is recorded as
    a **named input to #320**: the general config-vs-field rule should let a type declare a config key
    required, and `prompt.model` is its first case.

### The format bump and the codemod

11. **The format bumps to `path/workflow@3`**, documented in a new
    [`workflow-format-v3.md`](../format/workflow-format-v3.md) that supersedes `v2` (which is retained),
    matching how `@2` treated `@0`. Removing a *required* top-level field (`worker`) and changing the
    step-level `worker` from a tagged object to a name string is a grammar change, which `format` tracks
    — distinct from the step-type *set*, which it deliberately does not (`@2` §0). `@3`'s format doc
    deletes §7 "Worker declaration" outright: there is no worker *declaration* left, only an optional
    `worker` name on a step, which joins `parse`/`publish` in the §4 node table. `server-api-v0.md` §4 is
    edited in place (the wire is still `v0`; only a field changed, sub-decision 14).

12. **A codemod migrates `@2` files and refuses every case it cannot rewrite honestly.** New
    `scripts/migrate-workflow-format-v3.ts`, following its `v1`/`v2` predecessors — a hard
    bump-and-break, no compat read (PATH has never carried one, and a compat read would have to invent
    `config.model` behind the author's back). The rewrite:

    | `@2` | `@3` |
    | --- | --- |
    | `"format": "path/workflow@2"` | `"path/workflow@3"` |
    | file/step `worker: {type:"engine"}` | delete the key |
    | file/step `worker: {type:"llm", model, options?}` | delete the key; write `model`/`options` into that same object's own `config` |
    | `worker` on a `workflow` step | delete the key |

    It **never writes a `worker` name string**: every `@2` file reaches its type's default, because `@2`
    had one reachable implementation per type. It **hard-fails**, naming the file and the JSON pointer,
    on two classes it cannot rewrite without guessing:

    - **An interpolated `model`/`options`.** Hoisting `"${config.model}"` into literal config writes an
      inert string that no longer resolves — a silent behaviour change. The one benign sub-case is a
      `model` that is *exactly* `"${config.X}"` where `config.X` already resolves in scope: the hoist is
      then a no-op and the key is simply deleted. `docs/dogfood/github-release-notes.workflow.json` is
      precisely that case.
    - **A `prompt` step whose effective worker is `engine`.** It load-passes and run-fails today; after
      migration it would silently run on `sdk`, spending money the author never authorised. The codemod
      stops rather than migrate it.

    No file in the repo hits a failing case, so the strict rule costs nothing today and closes both
    silent-change classes forever.

### The public renames

13. **The processor cap is renamed across all four layers it appears on.** #313 sub-13 moved the cap
    from the type to the worker (memory per live Processor, not "LLM"), so the LLM name is now false, not
    merely dated. Renamed together: the constant `DEFAULT_LLM_CONCURRENCY` becomes
    `DEFAULT_PROCESSOR_CONCURRENCY`; the `runWorkflow` option `llmConcurrency` becomes
    `processorConcurrency`; the engine-settings key likewise; and the wire field `llm_concurrency`
    ([post-runs.ts](../../packages/server/src/routes/post-runs.ts),
    [api-client.ts](../../packages/client-core/src/api-client.ts)) becomes `processor_concurrency`. The
    server API is `v0` and unreleased, and ADR 0013's camelCase-in/snake-out seam makes the wire rename
    mechanical. A half-rename that stopped at the engine constant would leave "llm" at the exact place an
    operator types the number.

14. **The audit records a worker *name*, end to end.** #313 sub-18: `step-started` drops `worker: Worker`
    and carries `workerName: string`; `run-started` drops its `worker` field entirely (the file-level
    worker, which #309 removed). The SQLite `runs.worker` column becomes `runs.worker_name`, bumping
    `SCHEMA_VERSION` to 7 — a clean-slate bump-and-break with no backfill, exactly as #19/#169/#204/#202/
    #257 each did (`db.ts` states there is no migration framework pre-1.0). The `JSON.stringify`/`parse`
    pair leaves `run-store.ts` (the column holds a bare string now). On the wire, `WireRunRecord.worker`
    becomes `worker_name: string | null`, and the `step-started` log event's `worker: WorkerSchema`
    becomes `worker_name: z.string()`. The client view model's `worker` field renames to `workerName`
    (ADR 0013 makes that view a direct read of the row). A rename stopping before the ndjson log and the
    wire would leave an object-shaped `worker` in two persisted contracts with no object to hold.

15. **Test injection moves from `options.llmWorker` to `options.workerOverrides`, replace-only.** #313
    sub-16 retired `options.llmWorker` for "a registry override". Its shape is
    `{ [type: string]: { [name: string]: WorkerDescriptor } }`, merged over the frozen registry inside
    `runWorkflow`, **replacing** named `(type, name)` pairs only — an override naming a pair the scan did
    not produce is a hard error, never an insertion. This keeps the registry's name set owned entirely by
    the folder scan (ADR 0019 sub-2), the same discipline one level down. The acceptance run's scripted
    worker becomes an override of `("prompt", "sdk")`. The CLI's `RunOverrides.llmWorker`
    ([cli.ts](../../packages/engine/src/cli.ts)) renames to `RunOverrides.workerOverrides` with the same
    type, so the CLI forwards rather than translates. The public `@path/engine` index drops
    `LlmWorker`/`PromptRequest`/`PromptResult`; `@path/engine/plugin` is the only plugin-facing surface,
    and `workerOverrides` stays a host affordance off it.

## The required acceptance test

Following ADR 0020 sub-10's precedent (one acceptance test is part of the decision, not a follow-up):
**a `@3` file carrying no `worker` key anywhere runs a `binary` step and a `prompt` step end to end
through the scanned registry, with `prompt` overridden to the scripted worker.** That one test covers
the folder scan, the default-worker path for both built-in types, `(type, name)` dispatch, and the
override seam — the four things this migration can break.

## Considered options

- **Ship a multi-worker built-in to prove selection continuously** (an `echo` type, then a second
  `binary` worker `spawn`+`shell`). Rejected (sub-decision 3): selection is one map lookup with no
  two-worker-only code path, so a schema unit test proves it, and a shipped type invented to host a
  proof is the tail wagging the dog. `shell` also carried a wart — it would ignore or reject `binary`'s
  `args` field — for a convenience `command: "sh", args: ["-c", …]` already provides.
- **A compat read of `worker: {type: llm, …}` instead of a format bump.** Rejected (sub-decision 12):
  PATH bumps and breaks everywhere else, and a compat read would silently synthesise `config.model`, a
  data move a reader must not make unseen.
- **A codemod that guesses at interpolated `model` or resurrects an `engine`-worker `prompt` step.**
  Rejected (sub-decision 12): a codemod that guesses at a `${}` expression or silently repoints a step to
  a paid worker is worse than one that stops and prints the JSON pointer.
- **Give `prompt`'s `sdk` worker a default model** to keep the load-time check. Rejected (sub-decision
  10): a default model spends on a model the author never named.
- **Rename the concurrency cap only at the engine constant.** Rejected (sub-decision 13): it leaves the
  false "llm" name at the operator-facing wire field, where the cap is actually a per-Processor memory
  bound.

## Consequences

- **`src/llm/` is deleted.** `binary` and `prompt` live under `packages/engine/step-plugins/`,
  `processor-semaphore.ts` moves to `src/`, and the `LlmWorker` seam types are replaced by the #313
  seam. `@path/engine`'s public index sheds three exports.
- **`@path/schema` sheds five type exports** (`WorkerSchema`, `Worker`, `EngineWorker`, `LlmWorker`, and
  the `worker-type.ts` module), and the `worker` field is now a per-type `z.enum` the schema factory
  builds. The `step-started` log event and the `v0` wire run record carry `worker_name`.
- **The store bumps to `SCHEMA_VERSION` 7** (`runs.worker` becomes `runs.worker_name`), clean-slate, no
  backfill.
- **[#327](https://github.com/howardyang2009/PATH/issues/327) is resolved here, not separately.** The
  `CONTEXT.md` **Worker** entry is rewritten to "a named `run` method per step type", invariant 5 loses
  worker inheritance (config still inherits), and the leaf-step line no longer implies `binary`/`prompt`
  are a privileged closed pair. ADR 0020's trust wording on the **Worker** entry is carried through
  verbatim — it is orthogonal to what #309 changed. One new term is added, **default worker**.
- **[#320](https://github.com/howardyang2009/PATH/issues/320) inherits a named input** (sub-decision 10):
  the config-vs-field rule should let a type declare a required config key, with `prompt.model` the first
  case.
- **`prompt`'s `cli` and `remote` workers stay unbuilt** (sub-decision 2), each addable later as a second
  worker in the `prompt` folder with no schema change — the first real exercise of multi-worker shipping,
  whenever a headless path is wanted.
