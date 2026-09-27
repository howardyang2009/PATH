# The log event is the only event vocabulary

**Status:** accepted. Tracked by [#653](https://github.com/howardyang2009/PATH/issues/653).

## Context

"Something happened in a run" had three representations. The engine emitted an `Observation` (a
20-member union in `run-observer.ts`), built by one `Emitter` method per member, and the logging
observer projected it onto the schema-owned `LogEvent` with `toLogEvent`. The projection was not
one-to-one: `run-started` and `step-started` both became `step-started`, `run-finished` and
`step-finished` both became `step-finished`, `checkpoint-evaluated` split into `checkpoint-passed` and
`checkpoint-failed`, and four members were never narrated. Following one fact from a controller to
the viewer meant keeping an emitter method, an `Observation` member, a `toLogEvent` case, a
`LogEvent` member, the persisted observer's row write, and the wire shape in sync.

## Decision

`LogEvent` (`@path/schema`) is the only event type. The engine emits it directly, before the logging
observer stamps its per-root-run `seq`.

- The observer seam carries a `RunEvent`: `{ runId, rootRunId, event, payload? }`. `event` is the
  unsequenced `LogEvent`, or `null` for a fact only persistence records.
- What the log must not carry rides a small side channel, `RunPayload`: `started` (the row facts and
  `input`, on a `step-started`), `output` (on a succeeded `step-finished`), and the standalone
  `stderr`, `usage` and `context`.
- A workflow-run's start is its implicit root step's `step-started` with the reserved step type
  `workflow`; persistence and the server tell a workflow-run from a leaf by it. `workflow` is a reserved
  control name, so no plugin can claim it.
- The `Emitter` stamps the envelope and keeps only the methods with logic: `runStarted` (the root-only
  gate), `runFinished`, and the step sub-emitter's `started`, `finished` and `cancelled` pair. Every
  other event goes through `emit(node, body)`; a standalone payload through `record(payload)`.
- Masking stays at the one emit point and covers the event and the payload together.

## Considered Options

- **One `LogEvent` plus a payload side channel** (chosen). The payload union has five kinds that
  persistence needs, not a parallel copy of every event.
- **Keep `Observation` and generate `toLogEvent`.** Rejected: it keeps two vocabularies, and the
  non-one-to-one cases are exactly where a generator cannot help.
- **Put payloads on `LogEvent` and strip them in the log backend.** Rejected: the schema is the
  public, persisted shape, and a payload field there invites a reader to depend on it.

## Consequences

- `Observation`, `toLogEvent` and the per-kind emitter methods are gone; a new event type is a new
  `LogEvent` member plus, at most, a masking decision.
- The logging observer only sequences and fans out; the persisted observer reads the payload first,
  then the event.
