# The API client's endpoint groups are implementation, not a seam

**Status:** accepted. Reverts the `api/` file split of the "split the six oversized modules" refactor
for `@path/client-core`.

The v0 HTTP client was split into `api/{runs,workflows,templates,leases,transport}.ts` plus a
`PathApiClient` class that forwarded to them. Measured afterwards, every one of the class's 21
methods was a single `return group.fn(this.http, …)`, the group modules had exactly one importer
(`api-client.ts`), were absent from the package's `exports` map, and had no test that reached them
directly: the mock seam actually in use is `FetchLike`, and all 49 client tests build a real
`PathApiClient` over a stub fetch. So the split added a seam with no second adapter, and the
endpoint surface was then declared four times — the group function, the class method, the class's
type re-export block, and the package barrel. The file was in the top two churn spots in its package.

## Decision

1. **One module for the client.** `api/{runs,workflows,templates,leases}.ts` fold back into
   `api-client.ts` as sections: a function per route plus the input/result shapes its caller names,
   followed by the `PathApiClient` class.
2. **`PathApiClient` stays the interface.** Its 21 methods, their signatures and their docs are
   unchanged, and the package barrel still exports the class and its option/error types alone.
3. **The group functions are exported from the module, not the barrel.** A caller that wants one
   route without the class names it through the `@path/client-core/api-client` subpath; nothing new
   reaches the barrel.
4. **`transport.ts` moves up one level.** `HttpTransport`, `FetchLike`, `defaultFetch`,
   `ifMatchHeader`, `parseReply` and `toApiError` are the injectable `fetch` seam under the client,
   so they stay their own module rather than living in an `api/` folder of one file.
5. **A long file is not a defect here.** The sections are the endpoint groups; splitting them again
   would recreate a one-caller seam and a second declaration of the same surface.

## Considered Options

- **Fold the groups back in** (chosen). Smallest change: no caller, no test, and no exported name
  moves.
- **Promote `api/*` to the package's real seam** — export the group functions and `HttpTransport`,
  and delete the 21 forwarding methods. Rejected for now. It makes every surface assemble its own
  transport and endpoint calls, and every test stub would have to change, for no capability the
  class does not already give.
- **Keep the split as it is.** Rejected. An internal seam that nothing crosses buys no depth, and it
  is what made the surface churn on every endpoint.

## Consequences

- **`@path/client-core/api-client` is the one client subpath**, as before; `api/*` was never in the
  exports map, so no consumer path changes.
- **Adding an endpoint is one edit in one file** — the function and its class method — plus the
  barrel only if a new public type appears.
- **The four old modules' docs move with them.** Where a group function and its class method both
  carried the route's doc, the class method keeps the caller-facing wording and the function states
  only its own URL/body translation.
