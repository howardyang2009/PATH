# The API client's endpoint functions are implementation, not a public surface

**Status:** accepted. Supersedes decision 3 of
[ADR 0069](0069-the-api-clients-endpoint-groups-are-implementation.md); its decisions 1, 2, 4 and 5
stand.

ADR 0069 folded the `api/` split back into one module and kept the endpoint functions exported "so a
caller that wants one route without the class can name it". No caller ever did. Measured across the
workspace, the package barrel exports `PathApiClient` and its option/error types alone, the Viewer
and the Designer hold the class, and the one subpath consumer (`test/subpath.test.ts`) imports the
class too.

What the exports did produce was a second interface over the same 24 routes: every class method was a
one-line forward to a same-named function, each signature stated twice (including an inline request
shape for `deleteWorkflowFile` declared at both the function and the method). The seam that actually
varies has always been `FetchLike`, one level down in `transport.ts`.

## Decision

1. **The endpoint functions stay in `api-client.ts` and become module-private.** ADR 0069 decision 1's
   layout is unchanged; only the exports go. `PathApiClient` is the interface a surface holds.
2. **A request shape a caller names is declared once.** `DeleteWorkflowInput` is the one declaration
   shared by the function and the method that forwards to it.
3. **Do not reintroduce the seam speculatively.** If a caller ever needs one route without the class,
   that need arrives with a second adapter; exporting the function is not a substitute for one.

## Consequences

- The module's surface is the class plus the types its callers name; a route's shape is stated once.
- `@path/client-core/api-client` still serves the class to a caller that wants the client without the
  barrel; nothing about the wire behavior changes.
