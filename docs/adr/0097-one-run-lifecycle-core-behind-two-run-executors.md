# One run-lifecycle core behind two run executors

**Status:** accepted. Keeps [ADR 0091](0091-a-hosted-run-executes-in-one-vm-per-engine-invocation.md):
hosted runs still execute in one VM per engine invocation, and the host stays the record.

The in-process `LiveRuns` and `SandboxedRuns` each kept their own event hub, in-flight set, cancel
registry and rule for who owns a root during a Complete. The two drifted (one drained with
`Promise.all`, the other with `allSettled`), and no test ran the same case against both. The sandbox
also wrote the engine's root row by hand through `importTree`, re-deriving the `$secret` paths of the
launch facts; a missing field there was a shipped bug.

## Decision

1. **`liveRunsOver(store, executor)` owns the run lifecycle**: the live channels, the cancel
   registry, Complete's ownership of a root, the stream replay and the drain.
2. **A `RunExecutor` runs one operation** and reports through a `RunDrive`: the abort signal, whether
   another drive holds the root, `started` once the root exists, and `publish` for its events. There
   are two adapters, `inProcessExecutor` and `vmExecutor`.
3. **Each executor keeps its own concurrent-Complete rule.** In process, the engine's lease refuses a
   second Complete; in a VM, a held root is refused at once, since the VM works on a copy.
4. **`RunArchive.recordRoot` writes a host root row**, so the Server never names a `runs` column.

## Consequences

- `test/live-runs-contract.test.ts` runs the same start, stream, cancel, Resume and Complete cases
  against both executors.
- `LiveRuns` keeps its interface; the run routes are unchanged.
