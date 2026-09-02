# "Clean" is content-equality to the save-point baseline; one save-point serves launch, lease, and `If-Match`

**Status:** accepted; resolves the **dirty-state/undo** item of [#384](https://github.com/howardyang2009/PATH/issues/384)
(the deferred authoring-UX set graduated from Wayfinder map [#254](https://github.com/howardyang2009/PATH/issues/254)).
Discharges the obligation [ADR 0025](0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md)
recorded — *"that ticket must define 'clean' once for all three"* consumers (launch, the lease heartbeat,
the `If-Match` precondition). Builds on
[ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md) (the write route's
ETag `If-Match` precondition), [ADR 0017](0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md)
(the per-file edit lease and its heartbeat), and
[ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md) (client-minted, save-preserving
`id`s — the reason a canonical serialization is well-defined). The wire and UI contract is in
[docs/spec/designer-spec.md § Dirty-state, undo, and the save-point](../spec/designer-spec.md).

## What ADR 0025 deferred

ADR 0025 gated launch on a **clean** buffer and observed that three consumers must read "clean" the same
way, but it did not fix *what* clean is. The Designer as built (commit `503079e`) carries a placeholder:
two booleans, `edited` (a structure edit) OR `dirty` (the id-stamp repair applied on open), collapsed as
`dirty = edited || dirty` (`packages/designer/src/app.tsx`). This ADR replaces that placeholder with a
single definition and pins the undo model that sits on top of it.

## Decision

**A buffer is *clean* when its canonical serialization is byte-identical to its *baseline* — the on-disk
bytes the client last synced, the same value the write route's `If-Match` precondition carries. Otherwise
it is *dirty*. "Clean" is a content comparison, not a mutation flag.**

- **Baseline.** Each open file's buffer holds a baseline: the bytes (and their ETag) from the last
  successful open or save. A save that returns `200` advances the baseline to the write route's returned
  bytes/ETag (ADR 0016); nothing else moves it.
- **Canonical serialization.** The buffer serializes through one canonical serializer (stable key order,
  every `id` preserved per ADR 0015). Clean is `canonicalSerialize(buffer) === baseline.bytes`. This makes
  a no-op round-trip (type a character, delete it) clean, and it makes the id-stamp repair on open — which
  today marks a never-touched file dirty — clean unless the repair actually changed bytes.
- **One save-point, three consumers.** The baseline *is* the save-point. **Launch** enables only when the
  open file is clean (a launch runs the bytes on disk, ADR 0025). The **`If-Match` precondition** sends the
  baseline's ETag. The **lease heartbeat** is unchanged and **unconditional**: it beats every 10s
  regardless of dirtiness (ADR 0017), because the lease guards *authorship*, not bytes. The unification
  ADR 0025 asked for is therefore that all three key off the **same baseline object**, not that the
  heartbeat pauses while dirty.

### The undo/redo model

- **Granularity.** One undo entry is one structural edit (add, delete, reorder, replace) or one
  **coalesced** field edit — a run of keystrokes in a single pane field folds to one entry.
- **Scope.** The stack is the whole open file's node tree, not per-node.
- **Across a save.** A save does **not** clear the stack. Undoing *past* the save-point re-dirties the
  buffer (its serialization no longer equals the baseline); redoing back to it re-cleans it. This falls out
  of the content-equality definition for free — "clean" is re-evaluated after every undo/redo, not tracked
  as a separate flag.
- **Per file, not per session.** Each open file — the parent and every descended `workflow`-ref child — is
  its own buffer with its own baseline, its own lease (ADR 0017), and its own **independent** undo stack.
  Descending or ascending never merges stacks, because a ref'd file has several parents (the breadcrumb is
  a navigation stack, not a tree parent) and the two files save through two independent preconditions.
- **Redo** is cleared by any new edit.

## Considered options

- **A mutation-count dirty flag** (set true by any edit, cleared on save) — the current placeholder's
  shape. Rejected: it calls a no-op round-trip dirty, it calls the id-repair-on-open dirty though no author
  touched the file, and it is a *second* source of truth beside the ETag the precondition already carries,
  which can drift from it. Content-equality collapses "clean" and "the precondition will pass" into one
  fact.
- **Clean = the `saved` SaveState alone** (today's `SaveState.saved`, commented "the clean save-point the
  dirty flag clears against"). Rejected as the *definition*: a save-state is a transient UI phase, not a
  content relation, and it cannot answer "is the buffer, right now, equal to disk" after an undo. The
  save-state stays as UI; the content relation is the definition.
- **Clearing the undo stack on save** (a save is a hard boundary). Rejected: authors expect to undo across
  a save, and re-dirtying past the save-point is exactly the content-equality model's natural behaviour, so
  clearing the stack would remove a capability for no gain.
- **One shared undo stack across a `workflow`-ref descent.** Rejected: the two files are independent write
  targets under independent leases, and a child file has several parents — a shared stack would let an undo
  in one authoring context silently mutate another file's staged edits.

## Consequences

- **The placeholder two-boolean state is replaced.** `edited || dirty` gives way to
  `canonicalSerialize(buffer) !== baseline.bytes`. The `SaveState` union stays as the UI phase; the id-stamp
  repair stops forcing a spurious dirty (it dirties only if it changed bytes).
- **A canonical serializer becomes load-bearing.** It must be stable (key order, id preservation, ADR 0015)
  and shared with whatever the write route hashes for its ETag, so that "clean" and "`If-Match` matches"
  never disagree. This is the one real cost of the choice.
- **Backspace-delete unlocks.** `packages/designer/src/block-tree.tsx` binds Delete to the Delete key only
  and not Backspace, explicitly because "the dirty/undo model is a later #254 ticket" and a stray Backspace
  had no undo. With undo defined, Backspace-delete becomes safe.
- **Launch, lease, and precondition now share one object.** A later change to the save-point (say, a
  different hashing scheme) lands in one place rather than three, which was the point of ADR 0025's
  requirement.
