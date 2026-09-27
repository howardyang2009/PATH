# The Designer's write decision is one plan

**Status:** accepted. Holds the save-point rule of [ADR 0030](0030-clean-is-content-equality-to-the-save-point-baseline.md)
and the write door of [ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md).

"What does Save write?" was answered in five vocabularies, spread over five files:

- `session/save-plan.ts` — six plan functions with four different return shapes (`planSave` with three
  arms, `planNewFileSave`, `planNewTemplateSave`, `planTemplateSaveAs`, `planWorkflowSaveAs`).
- `document.ts` — `SaveDoor` (three values), `documentPolicy` deriving the door from a *parallel*
  restatement of the same rule, and `DocumentWrite`/`writeDocument` reading a `412`/`409` in document
  terms.
- `use-open-file.ts` — `save()` and `saveAs()` re-deriving the plan, building the write, and a
  **93-line unexported** `saveAsRequest` whose five branches built the write *and* the success action.
- `session/state.ts` — six save-related actions, each addressed by a different shape.
- `app.tsx` — the toolbar branching on `policy.saveDoor`, and five dialogs keyed off a sixth union.

Adding one save door meant edits in about five files, and the branchy half — `saveAsRequest`, plus the
workflow Save as… path — was reachable only by rendering the whole App. `planWorkflowSaveAs` was
imported by no test at all.

## Decision

1. **`planWrite(state, intent)` is the one authority** (`session/save-plan.ts`). Its intents are
   `{ kind: "save" }` and the five `SaveAsIntent` doors; it returns a `WritePlan` or a `WriteRefusal`.
2. **A plan carries the three decisions a caller would otherwise re-derive**: `write` (the
   `DocumentWrite`), `landed(result, savedBytes)` (the session action that advances the save point,
   ADR 0030), and `refused(outcome)` (the phase a refusal leaves: the stale-write conflict banner, an
   error to read, or `IDLE` where a dialog owns the refusal).
3. **A refusal names what the surface must offer instead**: `nothing-open`,
   `needs-workflow-path` (the first-save dialog) or `needs-template-name` (the new-template dialog).
   `documentPolicy.saveDoor` is a projection of that, not a second rule set.
4. **The write vocabulary moves with the plan.** `DocumentWrite`, `WriteSuccess` and `WriteOutcome`
   live in `save-plan.ts`; `document.ts` keeps the I/O (`loadDocument`, `writeDocument`) and re-exports
   the types, so no importer path changes.
5. **The hook executes, it does not decide.** `save()` is "plan, commit, apply the refusal phase";
   `saveAs()` is "plan, commit, map the outcome to the dialog's `created`/`exists`/`error`". The six
   old plan functions and `saveAsRequest` are gone.
6. **The plans are tested at their own interface.** `session-reducer.test.ts` drives `planWrite` per
   intent — including the two workflow Save as… doors that no test reached before — and asserts the
   write, the landing action and the refusal reading.

## Considered Options

- **One plan with the decisions attached** (chosen). The door rule, the token, the format and the
  identities are decided in one place; a caller cannot pair the wrong landing action with a write.
- **Keep `planSave` and friends, export `saveAsRequest`.** Rejected. Five vocabularies remain, and the
  uncovered paths stay uncovered — exporting a function no caller wants does not test it.
- **Make the plans return a `DocumentWrite` only, and keep the success actions in the hook.** Rejected.
  That is exactly the current split: the hook would still know which door lands which action, which is
  the knowledge the duplication consists of.
- **Fold `writeDocument`'s I/O into the plan.** Rejected. The plan stays pure (no `client`, no
  promises), which is what lets the tests drive it with no stub server.

## Consequences

- **`save-plan.ts` grows; `use-open-file.ts` shrinks by ~110 lines** and `app.tsx` no longer restates
  the door rule.
- **A new save door is one intent and one case** in `planWrite`, plus its dialog if it needs one.
- **The `PlanState` type names what a plan reads** — mode, frames, active index — so the save *phase*
  is a plan output only, and `planDelete` and `documentPolicy` take the same narrow view.
- **No behaviour change.** Statuses, wire bodies, conflict banners and dialog results are unchanged;
  the designer's 454 tests, including the five dialogs' end-to-end renders, pass as before.
