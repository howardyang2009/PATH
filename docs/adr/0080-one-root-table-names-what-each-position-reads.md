# One root table names what each position reads

**Status:** accepted. Extends [ADR 0079](0079-a-previous-root-names-the-predecessors-output.md)
decision 3.

`@path/schema` declared the root lists (`INPUT_ROOTS`, `PUBLISH_ROOTS`, `CONDITION_ROOTS`,
`STEP_ROOTS`), but which list each position reads was decided again in three packages: the zod
schema per field, the engine per scope it built by hand, and the Designer per editor and per
Reference list. Adding `previous` (ADR 0079 phase A) touched nine files. Two defects hid in the gaps:

- **Type fields had no root check at load.** Registry step types declare their fields as plain zod,
  so `prompt: "${previous.text}"` loaded, and the run failed when the step started. Format §5.6 says
  an authoring error surfaces at load, never mid-run.
- **An awaiting step's `outputSchema` had two scopes.** The park interpolated it with `config` and
  `context`; Complete interpolates it again with `config` only (ADR 0040). A schema that read
  `${context.x}` parked, then every Complete returned 400.

## Decision

1. **`ROOTS` in `@path/schema` maps each root position to its roots**: `input`, `publish`,
   `condition`, `typeField`, `awaitingSchema`, `limit` (`max_iterations`, `max_jumps`) and
   `fileOutput`. The named lists are gone. `nodePositions(type)` names the positions a node carries,
   and `typeFieldRoots(type, field)` the roots of one type field.
2. **Every type field is root-checked at load.** The engine interpolates every declared field at run
   start, so the schema checks every string leaf of every field against `typeFieldRoots`.
3. **A `person-activity` `outputSchema` reads `config` only** (`awaitingSchema`). ADR 0040 keeps the
   current file as the authority and rejects a snapshot at park, so Complete can resolve only
   `config`; the load now makes the park agree.
4. **The engine builds every scope through `scopeFor(position, values)`**, whose type comes from
   `ROOTS`. A new root is a compile error at each site that must supply it.
5. **`AWAITING_STEP_TYPE` lives in `@path/schema`**, read by the engine's Complete check and by
   `@path/client-core`.
6. **The Viewer's Complete pre-check skips a schema that holds a placeholder.** Only the server holds
   the run's config; the raw schema would disagree with the server's verdict.

## Considered Options

- **Let each step plugin declare which fields interpolate, and with which roots.** Rejected for now:
  the engine interpolates every field, so a per-field declaration would state a rule the runtime
  does not follow. The one exception (`outputSchema`) is a core type the schema already names.
- **Snapshot the resolved `outputSchema` on the awaiting row, or in the `step-awaiting` event.**
  Rejected by ADR 0040: the current file is the authority. The load restriction removes the
  disagreement without a second source of truth.
- **Send the resolved schema to the Viewer on the run read.** Deferred: it needs a wire field and a
  server-side resolution per read. The pre-check skip keeps the server the one authority meanwhile.

## Consequences

- A file that reads a root a type field cannot resolve no longer loads. Every tracked workflow file
  still loads.
- The Designer's Reference list for a `goto` now lists what `max_jumps` may read.
- The Viewer's Complete form still draws its fields from the raw schema, so an `enum` that reads
  `${config.x}` shows the placeholder text as an option.
