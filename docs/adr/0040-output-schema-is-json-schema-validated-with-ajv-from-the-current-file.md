# person-activity outputSchema is JSON Schema, validated with ajv, read from the current file at Complete

A `person-activity` node's `outputSchema` field is a **JSON Schema object** (optional; omitted means any JSON output is accepted). At Complete the re-invoked engine (ADR 0039) reads *this* node's `outputSchema` from the **current** workflow file by node id, re-interpolates it against the run's config, and validates the submitted output with **ajv**. Invalid output is refused (`400` with validation details) and the leaf stays `awaiting` for a retry; valid output is written as the step's output blob and the leaf moves to `succeeded`. The schema lives in the workflow file, never on the run row.

## Considered options

**Field format — JSON Schema vs Zod.** PATH validates its own internal shapes (plugin `fields` and `config`) with Zod. But `outputSchema` is author-supplied and lives inside `workflow.json`, and a Zod schema is *code*, not data — it cannot be a value in a JSON file. So the author-facing format is forced to JSON Schema. There is no real alternative here; this ADR records *why* the one type that carries a schema field breaks from the Zod convention.

**Validator — ajv vs convert-to-Zod.** Given the field is JSON Schema, we can either validate it directly with ajv or convert JSON Schema → Zod at runtime and validate with Zod (for consistency with the rest of the codebase). We chose ajv: it consumes the author's JSON Schema directly, while the conversion path adds a second, lossy translation layer (runtime JSON-Schema→Zod converters cover only a subset of the spec and silently drop unusual keywords). Direct beats a lossy round-trip.

**Where the schema is read — current file vs snapshot on the awaiting row.** We considered snapshotting the interpolated `outputSchema` onto the awaiting run row at park time, so Complete validates against exactly what the person was shown even if the author edits the file mid-wait. We rejected it. The engine reloads the file on the Complete re-invocation anyway (ADR 0039), and PATH's standing stance is that **the current file is the authority** (Resume re-validates against it). Persisting the schema would create a second source of truth that can disagree with the file and buys stability the rest of the durable-await mechanism does not have.

## Consequences

- **Edit-race, accepted.** If an author edits `outputSchema` between launch and Complete, the person validates against the *newer* shape, which may differ from the form they saw. This is a Viewer freshness concern (the form should reflect the current node), not a validation defect.
- `outputSchema` is one field serving two readers: a **UI contract** (Viewer/Designer build the Complete form from it) and a **validation contract** (Complete checks against it). Both read the same file-sourced schema.
- ajv is a dependency of the validation site (`@path/server`). A person-activity node with no `outputSchema` skips validation and accepts any JSON output.
- `parse: "json"` is a no-op for person-activity: the Complete body already carries a structured `JsonValue`, not a stdout string, so validation runs on the value as submitted.
