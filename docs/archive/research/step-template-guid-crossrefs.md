# Step-template instantiation: do `path/workflow@2` body fragments contain GUID cross-references?

Research ticket #559 (map issue #558). Question: within a `path/workflow@2` body fragment, is any
node wired to another node by that node's GUID (`id`), or is all intra-body wiring value-level
(context key / publish key / condition path) and name-level (branch names)?

This decides the step-template `insert` algorithm:
- **No GUID cross-refs** => `insert` stamps a fresh GUID per node and copies everything else verbatim.
- **GUID cross-refs exist** => `insert` must also rewire those references.

## Verdict

**No GUID cross-references exist within a body fragment. Rewiring is NOT needed.**

Every node's `id` is a durable, self-only identity GUID. All wiring *between nodes of a fragment* is
value-level (through the `config` / `context` / `output` namespaces) or name-level (a `parallel`
branch's `name` as its join-output key), never through another node's `id`. A `workflow` step points
at another *file* by relative `ref`, not at a node id. The only machinery that matches a node by its
GUID is **outside** the authored fragment: run rows (`nodeId`), log events, and the Resume/reuse
descent path. `insert` therefore only needs to mint fresh GUIDs per copied node (and keep `name`s /
publish keys collision-free, a value-level concern) and copy the rest verbatim.

## Evidence

### The `id` GUID is self-identity only; it is never referenced as a value by any field

`IdSchema` (a UUIDv4 regex) validates the `id` field and nothing else. Every occurrence of it in the
schema is a node's or the file's *own* `id`:

- `packages/schema/src/ids.ts:10-16` — `IdSchema` is "The durable machine identity `id` ... assigned
  once by the codemod and never regenerated — it is the reuse/resume key and the `node_id` a run row
  and log event carry." (i.e. identity + external match key, not an intra-body pointer.)
- `packages/schema/src/nodes.ts:17` — `commonStepFields.id` (every leaf step).
- `packages/schema/src/nodes.ts:71,94,104,119,128` — the `id` of `parallel`, `branch`, `while-do`,
  `sequence`, `checkpoint` respectively.
- `packages/schema/src/workflow-file.ts:23` — the workflow file's own `id`.
- `packages/schema/src/node-identity.ts:88` — validating `invalid-id` occurrences.

There is **no** field named `targetId` / `refId` / `nodeId` / `goto` / `jump` / etc. in the grammar; a
repo-wide grep for such value-carried-id lookups in `packages/schema/src` and `packages/engine/src`
returns nothing. So by construction a fragment holds no GUID that points at another node.

Uniqueness is enforced as a load error (`duplicate-id`, `packages/schema/src/node-identity.ts:34-37`),
which is exactly why `insert` must stamp *fresh* GUIDs — but that is minting, not rewiring.

### Node envelope: what a step can carry

`packages/schema/src/nodes.ts:16-22` — `commonStepFields = { id, name, config?, input?, parse?,
publish? }`. None of these reference a node id:

- `input` = `interpolatedJsonValue(STEP_ROOTS)` (`nodes.ts:19`).
- `publish` = `z.record(string, interpolatedJsonValue(PUBLISH_ROOTS))` (`nodes.ts:21`) — keys are
  context keys written; values interpolate.
- `worker` is a worker-*name* string enum, not an id (`nodes.ts:10-13`, `nodes.ts:229-236`).

### Interpolation (`${...}`) roots at `config`/`context`/`output`, never a node id

- `packages/schema/src/roots.ts:12` — `INTERPOLATION_ROOTS = ["config", "context", "output"]`.
- `STEP_ROOTS = ["config","context"]` (`roots.ts:19`), `PUBLISH_ROOTS = [...,"output"]` (`roots.ts:25`).
- `packages/schema/src/interpolation.ts:69` — a `${...}` placeholder yields `{ path: ... }`, validated
  by `checkDotPath` against those roots (`interpolation.ts:99-102`).
- `packages/schema/src/dot-path.ts:20-33` — the path's first segment **must** be one of the allowed
  roots; segments after it are identifiers/array-indices (`SEGMENT_PATTERN`, `dot-path.ts:13`). A GUID
  is never a legal root, so no `${<guid>...}` can exist. `resolveDotPath` walks the same value namespaces
  at run time (`dot-path.ts:61-86`).

### Branch / while-do / checkpoint conditions read context/output values, never a node id

- `packages/schema/src/conditions.ts:4-11` — every condition `path` is a `ConditionPathSchema` checked
  against `CONDITION_ROOTS`.
- `packages/schema/src/roots.ts:32` — `CONDITION_ROOTS = ["context", "output"]` (deliberately not even
  `config`). So a condition can only compare a *value* at `context.*` / `output.*`.
- Leaf predicates (`exists`, `equals`, `one-of`, `matches`, `range`, `valid-json`) carry a `path` plus a
  literal `value` / `values` / `pattern` / `min`/`max` — all JSON scalars, no ids
  (`conditions.ts:26-74`, `condition-type.ts:1-36`).
- `branch` arm = `{ when: Condition, node: SingleNode }`; `while-do` = `{ condition, max_iterations,
  node }`; `checkpoint` = `{ id, name, condition }` (`nodes.ts:83-135`).
- `while-do` bounds: `max_iterations = number | interpolableString(STEP_ROOTS)` (`nodes.ts:32`) —
  value-level (`config`/`context`), no id.

### `parallel` joins by branch `name`, and `workflow` steps reference a *file* by path

- `packages/schema/src/nodes.ts:73-80` — each `parallel` branch *is* a node carrying its own `id` +
  `name`; the comment states the `name` is "the `collect`/`wait-one` output key". So the join wiring is
  name-level, not id-level.
- `packages/schema/src/nodes.ts:24-28` — `workflow.ref` is a relative file path (not an interpolated
  position, not a node id).

### The publish/context wiring is value-level (a shared string-keyed namespace)

`packages/schema/src/publish-set.ts:41-53` — a node's `publish` map keys are "the context keys it
writes". The load-time checks reason purely over these string keys (sibling-race on duplicate context
keys `publish-set.ts:61-101`; detached-publish `publish-set.ts:108-133`). Producers and consumers meet
through the context-key string, e.g. an upstream `publish: { verdict: "${output}" }` feeds a downstream
`path: "context.verdict.pass"`. No GUID participates.

### The #459.1 person-switch example is a value match, not a GUID reference — confirmed

The real workflow `w1.workflow.json` (now in `examples/`) shows the exact pattern:

- `w1.workflow.json` `judge-draft` step publishes `verdict: "${output}"` (writes `context.verdict`),
  and the downstream `pick-format` **branch** arms compare `path: "context.verdict.suggested_format"`
  to `value: "short"` / `"long"`. The link is publish-key -> context path -> literal string. Pure
  value-level; the branch never names the upstream node's GUID.
- Same shape in `w2.workflow.json`: `checkpoint` `verdict-wellformed` reads
  `path: "context.verdict.pass"`, wired to an upstream `publish: { verdict: "${output}" }`.
- Every `id` in both files is a distinct GUID appearing exactly once — referenced nowhere else in the
  body. (Note: both files declare `format: "path/workflow@4"`; the *body/control-construct* grammar in
  question is the `@2` block grammar these constructs still use, per the `@2` §4.3/§4.4 citations in
  `nodes.ts:73-116`. Later format bumps changed the envelope, e.g. `@3` making `worker` a name, not the
  intra-body wiring model.)

### GUID matching lives in Resume/reuse machinery — outside the authored fragment

These match a node by `id`, but from *run rows* / a Resume *descent path*, not from a field inside the
body:

- `packages/schema/src/node-identity.ts:6-8` — `id` is "the durable GUID **Resume** matches a successor
  node on (ADR 0006)".
- `packages/engine/src/plan-reuse.ts:41-49` — `planReuse` maps original run rows to nodes by
  `candidate.nodeId === node.id` (a run-row → node match).
- `packages/schema/src/rerun-disposition.ts:40` — `rerunBoundaryIndex` finds the boundary by
  `body.findIndex((node) => node.id === head)`, where `head` is a `suffix` element of the root→K descent
  path that Resume carries (`rerun-disposition.ts:29-38`) — Resume state, not an authored fragment field.
- `packages/engine/src/plan-reuse.ts:64-75` — `findNestedCounterpart` matches by `(parent run, node
  id)` within the original tree.

All of these are consumers of node identity by the run/resume subsystem. None is a reference authored
*inside* a body fragment, so none is copied when a template is instantiated.

## Implication for `insert`

`insert` copies the fragment, mints a fresh UUIDv4 for every node's `id` (leaf steps, `parallel` /
`branch` / `while-do` / `sequence` / `checkpoint` containers, and any `parallel` branch node), and
copies every other field verbatim. It does **not** need to scan or rewrite any field for GUID
references, because none exist. The only non-GUID hygiene `insert` must respect is the file-wide
uniqueness of `name` (`node-identity.ts:32-33`) and the shared context-key namespace used by
`publish` (`publish-set.ts`), both value-level concerns independent of GUID stamping.
