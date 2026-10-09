# One write access decides who may change an authored file

**Status:** accepted. Implements the creator rule of
[ADR 0088](0088-each-request-sees-its-own-view-and-only-the-creator-writes-a-shared-item.md) in one
module; the rule is unchanged.

Each door rebuilt the chain itself: view, shipped and kind refusal, confinement, creator, shared-item
limit, file size, then the creator row after the write. The workflow store, the Template store and
discovery's `read_only` flag each called free functions over a `(layout, creators, limits)` triple
that always travelled together. The edit-lease doors checked the view only, so in hosted mode a user
who was not the creator could lease a shared workflow, and the creator's `DELETE` answered `409` until
the lease expired.

## Decision

1. **`WriteAccess` (`packages/server/src/write-access.ts`) is built per request** from the
   requester's layout, the creator table and their limits, and carried on the `RouteContext` as
   `access`. It answers `workflow(path)`, `createRefusal(origin)`, `sizeRefusal(bytes)` and
   `readOnly(file)`, and records `created` and `removed` shared items.
2. **Every door that writes, deletes or leases an authored file asks it.** The three lock doors
   refuse a path the requester may not change with the same status a write would get.
3. **The Designer takes no lease on a read-only workflow**, since the Server now refuses it.

## Consequences

- The free functions `sharedWriteRefusal`, `readOnlyFor`, `sharedItemLimitRefusal` and
  `fileSizeRefusal` are gone; `test/write-access.test.ts` covers the rules per path kind.
- The run doors keep `prepareWorkflow`: running a file needs no creator, only the view.
