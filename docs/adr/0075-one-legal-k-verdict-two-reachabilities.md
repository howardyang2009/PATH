# One legal-K verdict, two reachabilities

**Status:** accepted. Amends the split of [ADR 0032](0032-resume-from-k-boundary-representation-and-successor-provenance.md)
and [ADR 0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md); leans on
[ADR 0064](0064-a-sequence-body-is-transparent-to-the-rerun-boundary.md).

"Is this run a legal rerun boundary (K)?" had one shared *predicate* and two *compositions*:

- `@path/schema/legal-k.ts` exported `selectBoundary` (which run a selection is), `boundaryLevels`
  (its descent levels) and `classifyLevelK` (one level's verdict).
- `engine/resume-legal-k.ts` composed them into the authority: the selection refusals with their
  `400`, the per-level order, the nested `ref` descent via `descendNodePath`, and the §5 reason codes
  (`LegalKReasonCode`).
- `client-core/resume-from-eligibility.ts` composed them again for the button's eager check: its own
  reason union (`ResumeFromReasonCode`), its own precedence, its own wording, and its own rule for
  the nested case ("only the leaf's own success is checked here").

So the reason taxonomy existed twice, the precedence twice, and the barrel's claim that "neither can
accept a selection the other refuses" was checked by no test — three suites drove the two mirrors in
isolation. A new reason meant edits in three or four files.

The two compositions genuinely differ in one thing, and only one: the engine holds the loaded file
tree and can descend a nested K's refs; the Designer holds the open root file alone. Everything else
— which selection kinds are never a boundary, the locus rule, the leaf's own success, the prefix rule
and its order — is one law.

## Decision

1. **The whole verdict lives in `@path/schema`**: `legalKBoundary(rows, selectedRunId, scope)` returns
   `{ ok: true, nodePath, passes, nodeName, run }` or `{ ok: false, refusal }`, where the refusal
   carries one `LegalKBoundaryReason` — the three selection facts, the per-level taxonomy, and the two
   ways a nested `ref` stops a descent (`not-workflow`, `ref-unresolved`) — plus the facts a door needs
   to word it (`nodeName`, `pass`, `container`, `ref`).
2. **Reachability is the caller's honest fact, passed in as `LegalKScope`**: one file body per path
   level, and `stoppedAt` when a nested `ref` ended the descent. The **engine** passes every level its
   `descendNodePath` reached and maps the miss; a **surface** that holds only the root file passes that
   one body, and a level past the end is judged on its own run status alone — which is exactly what the
   Designer's mirror did, now stated instead of re-implemented.
3. **A door keeps its status and its wording.** `resume-legal-k.ts` maps a reason to `400`/`409` (bad
   selection or locus `400`; a moved-on tree `409`) and prints the CLI's long sentence;
   `resume-from-eligibility.ts` maps it to a disabled button and its short copy. That is the whole of
   the difference between them, and it is where they genuinely differ.
4. **The client's own two states stay client-side**: `no-selection` (nothing selected, or the root row)
   and `dirty-buffer` (a legal K over an unsaved file, ADR 0030's save-first gate). The shared verdict
   knows nothing of a buffer.
5. **The law is tested once**: `schema/test/legal-k.test.ts` drives `legalKBoundary` over the selection
   kinds, the locus, the prefix, the stopped descent, and the past-the-scope rule — including that a
   single-use row iterable is enough.

## Considered Options

- **One verdict with a scope** (chosen). One order, one taxonomy, and the only asymmetry that exists
  is in the types.
- **Move the descent into schema.** Rejected for now. It would pull the engine's ref resolution and
  the loaded-file-map contract into a package that owns the format, not the file tree — and the
  Designer would still not have the files to pass.
- **Have the client call the engine's authority over the wire.** Rejected: the button's whole point is
  to grey before a round-trip, and the engine remains the last word on click.
- **Unify the wording too.** Rejected: the engine prints a sentence into a CLI log and the button
  shows a tooltip; the reasons are shared, the register is not.

## Consequences

- **`LegalKReasonCode` is the shared `LegalKBoundaryReason`**, so the `--list-eligible` column and the
  button read one taxonomy; `eligibilityCell` gained the two descent reasons with its own wording.
- **Two dead branches disappear**: the engine's `!levelInfo` case (its descent always pushes a level
  for the index it tried) and the client's hand-written root-level classifier.
- **A new reason is a compile error in every door**, because both switches are exhaustive over the
  shared union.
- **No behaviour change.** The engine's messages and statuses, and the button's reasons and copy, are
  unchanged; the engine's 30 legal-K tests, the client's 21 eligibility tests and the Designer's
  resume-from-K renders pass untouched.
