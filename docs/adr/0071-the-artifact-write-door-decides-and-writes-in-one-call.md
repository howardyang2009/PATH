# The artifact write door decides and writes in one call

**Status:** accepted. Enforces the precondition of
[ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md).

`artifact-file.ts` exposed the three steps of a conditional write as three functions —
`readArtifact`, `checkPrecondition`, `writeArtifact` (and `deleteArtifact`) — and required every door
to call them adjacently. The requirement was load-bearing and invisible: the `If-Match` compare and
the write have to sit in one **synchronous** block, because an `await` between them turns the ETag
compare-and-swap into a TOCTOU race. Nothing said so in the types. Each door restated it as a
comment in its own words ("Precondition and write are one synchronous block", "Read-decide-delete is
one synchronous block (no `await`)", "a single synchronous block — no `await` between them"), the
three doors did not even agree on what "current bytes" meant (`put-workflow` re-read the file;
`put-template` reused bytes captured by an earlier scan in the same request), and no test could see
the property: the unit tests exercised the three pure steps in isolation, and the route tests can
only observe the outcome.

## Decision

1. **One call per conditional artifact operation.** `conditionalWrite(absPath, { ifMatch, rule,
   payload })` and `conditionalDelete(absPath, ifMatch)` each read the current bytes, decide
   `If-Match` against their strong ETag, and write or remove — inside one synchronous call. There is
   no seam a door could accidentally suspend across.
2. **The read and the check are private.** `readArtifact` stays exported for the read-only door
   (`GET /v0/workflows/file`); `checkPrecondition`, `writeArtifact` and `deleteArtifact` do not.
3. **The result carries only what the door's answer needs.** `conditionalWrite` reports `etag` and
   `created` (the `200`-vs-`201` fact) or the `ArtifactConflict`; `conditionalDelete` reports the
   conflict, where `missing` is the file-already-gone case a delete door answers `404` (not the `412`
   the other conflicts take).
4. **The current bytes are read by the operation, not handed in.** A door that captured bytes earlier
   in the request is a door whose token can describe a file it no longer has.
5. **The atomicity property is tested where it lives.** `test/artifact-file.test.ts` drives the two
   operations directly over a temp dir: every conflict keeps the file untouched, a create never
   clobbers, and a matching token overwrites.

## Considered Options

- **One conditional operation** (chosen). The invariant moves inside the interface; the three route
  comments about synchronous blocks delete themselves, and a door cannot forget it.
- **Keep the three steps and add a test hook** (a `beforeWrite` callback the tests could use to
  interleave). Rejected. It makes the hazard injectable for tests while leaving it reachable in
  production, and the doors would still have to know to keep the steps adjacent.
- **Serialize every door's access through a queue or a lock.** Rejected as unnecessary: the
  process is single-threaded and the operation is synchronous, so there is no window to close beyond
  the one an `await` would open.
- **Move the whole thing into `@path/engine`.** Rejected for now. The artifact file and its strong
  ETag are a server write-door concern (server-api-v0.md §7, §10); the engine does not address
  workflow files by path.

## Consequences

- **`delete-workflow` checks its edit lease before the conditional delete.** The lease is another
  session editing the file; the file is untouched either way, and a held lease now outranks a stale
  token where the two coincide (previously `412`, now `409`). No existing test pinned that pair.
- **`put-template` validates the body before spending the precondition.** The body's `id` match and
  the registry-relative schema check now precede the written-file token, which is the order the API
  doc gives the write pipeline. A request that is both invalid and stale answers `400`.
- **A vanished template file is a `412`, not a `500`.** `put-template`'s precondition used to be
  checked against scan-time bytes and the write would then throw `ENOENT`; the operation reads at
  write time, so the refusal is the ordinary `missing` conflict.
- **`post-templates`' exclusive create is the same call** with `rule: "create-or-overwrite"` and no
  token, so the `wx` race and the `409` it feeds stay in one place.
