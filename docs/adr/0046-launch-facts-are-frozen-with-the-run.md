# The operator's launch facts are frozen with the run

**Status:** accepted; extends [ADR 0044](0044-worker-defaults-a-launch-door-and-a-file-table.md), whose
launch worker-default table becomes one field of this record.

An operator supplies three things at launch beyond the workflow file: an **input override**, a
**config override**, and the **launch worker-default** table. Only the third was frozen with the run
(ADR 0044). Config was applied to the launch's own engine invocation and then dropped, so any later
invocation of that run — a **Resume**, or the **Complete** that re-drives a tree parked at a
`person-activity` step — ran without it. The failure was ordinary and confusing: a `deepseek` step
whose credential the operator had supplied in the launch form ended with
`DEEPSEEK_API_KEY is not set` on the *continuation*, while the run they launched looked correct. The
input override was not even recorded: the root row kept the resolved seed, so nothing could say
whether the operator had supplied one.

Decision: **one frozen `launch_facts` object per run tree** — the input override, the config override,
and the launch worker-default table — recorded on the root row at launch, recovered by Resume and
Complete, and exposed on the run-tree read.

## Decision, in parts

1. **Three facts, one record.** `LaunchFacts = { input?, config?, workerDefaults?, secretKeys? }` on
   the root row, written through the root `run-started` observation and its one persistence door. The
   worker-default table stops being a column of its own; `getLaunchWorkerDefaults` becomes a projection
   of this record, so the four-tier dispatch order is untouched.
2. **Config is frozen resolved and masked.** The stored value is the operator's override after `$env`
   lookup and `$secret` unwrapping (ADR 0022 sub-4), then scrubbed by value at the emit choke point, so
   a credential reads `"[secret:<key>]"`. `secretKeys` names the config dot-paths that were secrets —
   the token says a value is missing; the key list says *which* value, and it is what lets a
   continuation ask for them by name.
3. **Recovery is merge, supplied wins.** A continuation recovers `config` and `workerDefaults`. A
   config the caller supplies on the continuation merges over the frozen one, shallow per top-level key,
   exactly as an operator override merges over a file's defaults. Changing a launch fact is otherwise a
   new run.
4. **An unrecovered secret fails the run, before its first step, naming every key.** The frozen copy
   holds a token where the credential was; replaying that token into a provider is the "silent wrong
   credential" this project refuses. The failure is the shape `describeUnsetEnv` already set — the run
   starts, is on the record, and ends naming what to set — and the continuation's own `config` field is
   the door that supplies it. A value supplied at a recorded secret path is re-marked `$secret` before
   anything reads it, so the successor's own frozen copy is masked too rather than recording the
   re-entered plaintext.
5. **The input override is recorded and shown, never re-applied.** Resume restores the context
   blackboard from the predecessor's `context.json` and Complete restores the parked tree's own
   (ADR 0041); a fresh input seed would be silently discarded. Recording it is what lets a reader see
   what the run was launched with, which the resolved root input alone cannot say.
6. **The facts are readable.** `GET /v0/runs/:root_run_id` carries `launch_facts` beside `runs` (a
   per-tree fact, not a per-row one), and `GET /v0/runs` carries `launch_secret_keys` — names only — on
   each root summary so a Resume surface can ask for a masked secret before it submits. The Complete
   body gains the same optional `config` the Resume body already had, with the same ADR 0012 `$env`
   reject.

## Considered options

- **Freeze the config raw.** The simplest replay, rejected: a credential would sit in `.path/path.db`
  and in the NDJSON log in the clear, contradicting the invariant `secret-mask.ts` states — a `$secret`
  value "must never reach disk or a backend".
- **Drop secret-valued keys from the frozen config.** Rejected: a dropped key is indistinguishable from
  one the launch never supplied, so no surface can say which values are missing or why a step failed.
- **Refuse the continuation at the route instead of failing the run.** Rejected: the engine owns the
  run-start gates (`$env`, config fragments); a route-level refusal would have to be repeated in the
  CLI, the Complete route and the Resume route, and the refusal would leave no run on the record saying
  what happened.
- **Re-apply the frozen input on a continuation.** Rejected in sub-decision 5: it would race the
  context restore for no gain — the input seed exists to seed a fresh blackboard.
- **Keep three columns (`launch_input`, `launch_config`, `launch_secret_keys`).** Rejected in
  sub-decision 1: one object written together and read together earns one column and one read, and the
  worker-default column folds in without a second migration later.
- **Put the facts on each row of the wire `runs` array.** Rejected: they are per-tree, so repeating
  them per row would be noise and would put per-tree data through the record's one-manifest codec.

## Consequences

- **Store bump 11 → 12**, bump-and-break as always pre-1.0 (`packages/engine/src/persistence/db.ts`):
  `runs.launch_worker_defaults` becomes `runs.launch_facts`, and an existing `.path/path.db` refuses to
  open until it is deleted. Blobs are unaffected; recorded rows are lost.
- **`run-started` carries `launchFacts` where it carried `launchWorkerDefaults`.** A plugin or
  observer reading the old field must switch; ADR 0044's dispatch behaviour is unchanged.
- **Masking covers the new payload.** `maskObservation`'s `run-started` case scrubs `launchFacts` like
  `input`; the `never` guard does not force this (the fields are optional), so `mask-observation.test.ts`
  carries a sample.
- **The secret check is run-wide, not per re-run step.** A Resume that reuses every step still fails
  without the secret, exactly as an unset `$env` a shadowed config names still fails the run. The cost
  is accepted for the same reason: one gate before the first step, not a surprise at step 14.
- **The Viewer's run-detail pane shows the facts for a root run**, and the Complete and Resume forms
  turn a masked secret into a re-entry field, which is the surface the failure needed all along.
- **CONTEXT gains *Launch facts*** and *Operator config* records that the operator's values are frozen
  where they were previously re-supplied per invocation.
