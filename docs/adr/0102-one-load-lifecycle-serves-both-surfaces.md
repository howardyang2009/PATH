# One load lifecycle serves both surfaces

**Status:** accepted. Extends [ADR 0076](0076-a-runs-files-are-read-through-one-seam.md), which
promised that a read's cancellation and failure rules would be shared.

The Viewer had one load lifecycle (`use-resource.ts`: the three-phase `Load`, the monotonic
generation that drops a landing the inputs have outrun, `pollMs`, `refetch`), and the Designer had
none. The Designer hand-rolled the same shape four times: a `cancelled` flag for the run-file-set
read, an `alive`/`lastGood` pair for the save-phase scans, and a `latest` epoch for the armed
template read. Each copy got a slightly different error rule — `run-dock` swallowed its failure
into an empty set — and `useResource` was not exported, so none of them could reuse it.

## Decision

1. **`useResource` is the one load lifecycle, and it is exported** from `@path/viewer` and from the
   `@path/viewer/use-resource` subpath. The subpath carries `Load` with it, so a framework layer
   that must not pull the whole Viewer barrel can still cross this seam.
2. **The hook owns two options the copies needed.** `keepLastGood` carries the last landed value on
   the `error` phase, for a host that must keep showing its stale list rather than empty itself on a
   read blip; `manual` keeps the current value on screen while a `refetch` is in flight, so a
   `deps`-driven scan does not flash `loading` on every save.
3. **The Designer routes its scans through it.** `useScanOnSave` is a thin `rescanOn` trigger over
   `useResource`, the registry read is one `useResource` call whose ready phase flushes the queued
   opens, and the run dock's run-file-set read is one `useResource` call with `enabled: false` for a
   never-saved buffer.

## Consequences

- `RegistryLoad` becomes an alias of `Load<WireStepPlugin[]>`; the session reads
  `registry.value`.
- A read driven on demand rather than by the render (the armed template) stays imperative: it is not
  a load, and forcing it into the lifecycle would add an `enabled` toggle that re-reads on mount.
- The Designer's `scan-on-save.test.tsx` still crosses the same interface, now through the shared
  hook.
