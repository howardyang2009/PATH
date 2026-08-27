# A step type declares typed `fields` and `config` fragments, and the line between them is operator-invariance

**Status:** accepted; the config-vs-field-vs-input decision of map
[#308](https://github.com/howardyang2009/PATH/issues/308), resolving
[#320](https://github.com/howardyang2009/PATH/issues/320). Builds on the
[#309](https://github.com/howardyang2009/PATH/issues/309) keystone (a Worker is a named `run` method per
step type), the [#313](https://github.com/howardyang2009/PATH/issues/313) resolution (the
`run(fields, input, config, cwd, signal)` seam, where the engine has already merged `config` and resolved
`$env` before the call), [ADR 0018](0018-open-node-union-via-pure-registry-factory.md) (a plugin
contributes an extra-field fragment; the factory composes the strict envelope),
[ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md) (`$secret`/`$env` are
representable in config **only**; `collectSecrets` walks config), and
[ADR 0021](0021-built-ins-are-the-first-two-plugins-and-the-engine-llm-union-is-gone.md), which handed
this ticket a **named input** (sub-decision 10): the config-vs-field rule should let a type declare a
required config key, with `prompt.model` the first case.

ADR 0018 sub-decision 4 fixed *where* a plugin's extra fields attach (the strict envelope) and explicitly
deferred *which* of them are `$env`/`$secret`-capable config versus step data — "that line is #320." This
ADR draws it. It is the last decision ticket of map #308 beside #319 (built-in migration, ADR 0021).

**Amends** ADR 0018 sub-decision 4 (a plugin now declares **two** typed fragments, `fields` and `config`,
not one) and the CONTEXT.md **Config** entry (the example list drops "endpoints"; a new term **Type
field** is added). It amends no other ADR.

The keystone made a worker's `run` receive resolved `fields`, one `input`, and merged `config` (#309,
#313). Three kinds of data reach a step, and until now a plugin author had no rule telling which declared
datum is which, and no schema mechanism to enforce the split. This ADR pins both.

Decision: **a step type declares two typed zod fragments — `fields` (author-fixed on the node, strict,
validated at load) and `config` (injected from outside, open/passthrough, validated at run-start on the
effective merged config). The author-facing rule that sorts a datum into one or the other is
operator-invariance: a datum that is the same for every operator and every run is a field; a datum injected
from outside, inheritable and operator-overridable, is config. `input` stays one opaque `JsonValue`, and
`parse` stays a shared node-level envelope field.**

## The rule: operator-invariance

- A **type field** is author-fixed on the node. It is the same for every operator and every run. It says
  *what the step does*: `api-call`'s `endpoint` and `method`, `binary`'s `command` and `args`, `prompt`'s
  `prompt` text. It is interpolable (`${config.x}`, `${context.y}`) and author-written per step.
- **Config** is injected from outside the node: inheritable downward, operator-overridable at launch,
  `$env`/`$secret`-capable. `api-call`'s `token`, `prompt`'s `model` and `options`.

The sharp test is **not** "does the user type it at launch" but **"is it fixed on the node (field) or
injected from outside (config)."** An auth `token` is the clean case because it is both per-user *and*
secret. `model` is config **without being either**: an author writes `config.model` at the file top and it
inherits to every prompt, yet it is config because it is operator-*overridable* and injected, not because
each user supplies it. The endpoint of an `api-call` is a field because it is what the call *is*, the same
for every operator — which is why the CONTEXT.md Config example list, which had listed "endpoints," is
corrected here.

## The eight pinned sub-decisions

### The declaration mechanism

1. **A plugin declares two typed fragments, `fields` and `config`, both `ZodRawShape`.** ADR 0018
   sub-decision 4 had a plugin contribute one extra-field fragment. It now contributes two, sitting in the
   registry entry beside `workers`/`defaultWorker` and `fields`. `api-call`'s are
   `fields: { endpoint: z.string(), method: z.enum([...]) }` and `config: { token: z.string() }`;
   `prompt`'s `config` is `{ model: z.string(), options: z.record(...).optional() }` (its prompt text is a
   field). The alternative — one `fields` fragment plus a convention that config stays the free-form
   untyped map — was rejected: only a typed `config` fragment can carry the required-key job ADR 0021
   sub-decision 10 handed this ticket, and the operator-invariance rule is clean enough to enforce
   structurally rather than by author discipline.

2. **`fields` is `.strict()`; `config` is open (passthrough).** The node top is the author's and fully
   known, so an unknown field key is a load error, exactly as ADR 0018 sub-decision 4 already makes the
   whole envelope strict. Config cannot be strict: it inherits downward, and a parent workflow sets config
   keys for *sibling* leaf types a given leaf never declares. A given leaf's effective config therefore
   carries keys it does not know, and a strict config schema would reject them and break inheritance
   (invariant 5). So the `config` fragment declares only the keys the type *needs* — some required — and
   passes the rest through untouched.

### Validation and the required key

3. **Fields validate at load; config validates at run-start.** Fields are static on the node, so the
   schema factory checks them when the workflow loads, with every other envelope invariant. Config is
   merged across ancestors and the operator's launch-time override, then `$env`/`$secret`-resolved (#313's
   seam does the merge and resolution before `run()`). Its validation therefore happens at **run-start, on
   the effective merged config, after resolution, before the first step** — colocated with the `$env`
   resolution point (ADR 0012, ADR 0020). This is the same run-start gate the unset-`$env` check fires at,
   and one failure names every missing or mismatched config key, matching the `describeUnsetEnv` precedent
   (`packages/engine/src/resolve-env.ts`).

4. **The `config` fragment's leaf types describe the *resolved* value.** An author writes
   `model: z.string()`, meaning "resolves to a string." The `$env`/`$secret` *wrapper* forms
   (`{"$env": "..."}`, `{"$secret": ...}`) are the envelope's and the resolver's business, not the plugin
   author's: config is validated **after** resolution (sub-decision 3), so `z.string()` checks the literal
   the wrapper resolved to. A plugin author never writes the wrapper shape into a fragment.

5. **A required config key is a non-optional key in the `config` fragment — no new mechanism.**
   ADR 0021 sub-decision 10 asked #320 for a way to declare a config key required, recording `prompt.model`
   as its first case (as `config.model` it regressed from a load-time to a run-time check, accepted there).
   That way is plain zod: `model: z.string()` is required, `options: z.record(...).optional()` is not. The
   run-start check (sub-decision 3) enforces it. `prompt`'s missing-`model` failure is now a named,
   aggregated run-start error rather than the bare mid-run failure ADR 0021 left it as.

### Secrets, input, and parse

6. **Secret-bearing data enters only through config; a field holds no wrapper.** ADR 0020 sub-decision 2
   already makes `$secret`/`$env` representable in config only and has `collectSecrets` walk config. This
   ADR states the field side of that boundary: a `fields` fragment leaf **cannot** hold a `$env`/`$secret`
   wrapper. A field may still **interpolate** `${config.token}` where `token` is a secret; the value is
   masked wherever it lands, because masking is by-value and the masker already collected that secret from
   config (ADR 0020). Interpolating a secret into a field is therefore **allowed**, not a load error:
   forbidding it would need run-time interpolation-source tracking PATH does not have, and it opens no new
   audit surface.

7. **`input` stays one opaque `JsonValue`; a type declares no named input fields.** The worker reads
   `input` in `run(fields, input, config, …)` as the predecessor's single output object. Outputs are
   `JsonValue` and the cross-step contract is author-trust — PATH has no output typing. A per-type named
   input schema would invent a load-time cross-step type check the system deliberately lacks, so `input`
   is not part of a plugin's declaration.

8. **`parse: text|json` stays a shared node-level envelope field.** It sits in `commonStepFields` (ADR
   0018 sub-decision 4, kept there deliberately) and stays there. It is not a type field: it is not
   type-specific, since any leaf type may emit a string worth parsing. It is not config: it is an
   output-interpretation directive for this one step's result, not data injected from outside. `parse:
   "json"` applies to a string result only (#313); the registry cannot know statically whether a run's
   result is a string, so there is still no load-time check to move. A type that always emits structured
   data simply has its worker return a `JsonValue`, making `parse` a no-op.

## Considered options

- **Convention instead of a typed `config` fragment** (sub-decision 1). Rejected: it cannot carry the
  required-key job ADR 0021 handed this ticket, and it leaves the operator-invariance line to author
  discipline where a schema can enforce it.
- **A strict (closed) `config` fragment** (sub-decision 2). Rejected: config inherits, and a leaf's
  effective config legitimately carries keys meant for sibling types. A closed schema would reject them and
  break inheritance.
- **Validating config at load** (sub-decision 3). Rejected: a required key may be satisfied by inheritance
  or operator override at launch, and `$env`/`$secret` resolve at run-start. Load-time cannot see the
  effective config, so the check must run where `$env` does.
- **A bespoke required-config-key declaration** (sub-decision 5). Rejected: zod optionality already
  expresses it, and inventing a parallel mechanism duplicates what the fragment already carries.
- **Named, schema'd input fields per type** (sub-decision 7). Rejected: it implies a cross-step output
  contract PATH does not have; the input's shape is an author-trust concern, like every other cross-step
  dataflow.

## Consequences

- **A plugin's declaration surface gains a second fragment.** `defineStepPlugin` /
  `@path/engine/plugin` now takes `{ fields, config, workers, defaultWorker }`. The built-ins declare it:
  `binary` has `config: {}` (it needs none), `prompt` has `config: { model: z.string(), options?
  }`. This amends ADR 0018 sub-decision 4.
- **`prompt`'s missing-`model` error improves.** ADR 0021 sub-decision 10 left it a bare mid-run failure;
  it becomes an aggregated, named run-start failure alongside any unset `$env`, closing the regression that
  ADR recorded as a named input to #320.
- **Config validation joins the run-start gate.** The engine's existing `$env`-resolution / config-merge
  point gains a per-type config check; `@path/schema` stays a pure function of its inputs and does no
  filesystem or environment access (ADR 0018 sub-decision 1 unchanged).
- **CONTEXT.md gains the term *Type field* and corrects *Config*.** The Config example list drops
  "endpoints"; the operator-invariance line is stated. The two-fragment declaration shape stays in this ADR
  — CONTEXT.md remains a glossary, not a spec.
- **Map #308 has one decision ticket left, #319**, itself resolved by ADR 0021. With #320 closed, the
  assembly item graduates: the map has landed one ADR per decision (0018, 0019, 0020, 0021, and this 0022)
  rather than a single integrating record.
