# One admission module decides what a hosted user may do

**Status:** accepted.

One hosted Start crossed six modules: the route table's rate limit and body cap, its launch gate,
a `RunOwner` closure in `create-server.ts` over the run limits and VM usage, the VM slots, and
`SandboxedRuns`'s checks at slot grant and import. `ServerContext.limits` was typed without the VM
usage the closure read. The pure parts had tests; the closure that joined them had none.

## Decision

1. **`Admission` (`packages/server/src/admission.ts`) owns the limits file, the request counters,
   VM time and storage.** Its interface is `limitsOf`, `admitRequest`, `gateRefusal` and `runOwner`.
2. **Two adapters:** `hostedAdmission` and `UNLIMITED_ADMISSION` for local mode, so the route table
   asks the same questions in both modes.
3. **Limits are unchanged.** A queued VM is still checked again when it starts and when it imports.

## Consequences

- `test/admission.test.ts` drives the wiring the route table and the VM runs share.
- `ServerContext` carries `admission` in place of the optional `limits` triple.
