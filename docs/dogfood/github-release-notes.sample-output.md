<!-- Captured output of one live run of github-release-notes.workflow.json, 2026-08-02.
     v0.4.1..v0.4.3, 24 references resolved against api.github.com, 0 unresolved.
     Committed because root .gitignore excludes .path/, so this is the only run artifact a reader can see.
     Not edited: this is exactly what the run wrote to release-notes-enriched.md. -->

# Release Notes: v0.4.1 – v0.4.3

## `$env` and Secret Sourcing

- Reserved the `$`-sole-key namespace: an unknown `$key` is now a load error (#120)
- Resolved `$env` at run start, before masking, failing fast with the full missing list (#116, #121)
- Added acceptance coverage for the synthetic `$env` + `$secret` case: the real value reaches the worker while `[secret:token]` is what lands on disk (#117, #122)
- Fixed `path run` printing an unmasked error to its own stderr — a credential leak into the CI build log — and masked what a finished run hands back; §8.3 now names the masked surface that actually exists (#123, #124, #126)
- Documented `$env` in format §8 and spec §8.3 as a shipped rule rather than an open door, retired the old §10 row, and recorded the server trust argument (#118, #125)
- Added the `$env` wrapper: shape, zod widening, and a single depth walk
- Shared one wrapper descent between `mapSecrets` and `mapEnv`

## Ownership & Architecture Refactors

- Gave the read side of `.path/` an owner (#81)
- Consolidated the live run's five owners into one (#83)
- Unified the event stream's framing, previously written four times, into one codec (#85)
- Extended the node seam to cover all seven kinds, closing the gap at five (#87)
- Moved two questions the viewer was answering into client-core, where they belong (#89)
- Fixed a worker-supplied usage payload crossing the masking seam unmasked (#91)
- Separated the binary step's process driver from the run-tree walk (#94)
- Withdrew the surface each deepening superseded (#96)
- Established one owner for what a `$secret` is, across schema and engine (#98)
- Unified the write side of `.path/` into one module (#100)
- Pinned node semantics at the seam instead of twice (#102)
- Made the db log backend one sink that knows its table (#104)
- Declined restructuring the run row's four shapes; guarded wire drift with a compile-error test instead (#107)

## Engine & Tooling

- Added replay of a run's narrative from `log_events` when ndjson is off
- Added the lavish explain HTML output

## Documentation

- Updated the README with status through v0.4.2 and what's still open
- v0.4.2 changelog
- v0.4.3 changelog: `$env` secret sourcing, plus the review pass that never shipped (#127)