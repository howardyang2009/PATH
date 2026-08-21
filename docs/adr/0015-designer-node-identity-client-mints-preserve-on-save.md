# Designer node identity: the client mints ids, the server never rewrites them, and a save preserves every id

**Status:** accepted; resolves [#256](https://github.com/howardyang2009/PATH/issues/256) on map
[#254](https://github.com/howardyang2009/PATH/issues/254) (the Designer spec). Builds directly on
[ADR 0006](./0006-workflow-and-node-identity-guid-plus-name.md) (the `id`=GUID / `name`=human split)
and [ADR 0007](./0007-workflow-format-v1-audit-node-name-output-keyed-by-name.md), and assumes the
`@2` container shape of [ADR 0014](./0014-single-node-container-slots-and-sequence-logicer.md), under
which every slot occupant is an ordinary node carrying its own `id`.

A canvas editor rewrites the whole file on every save. ADR 0006 made the node `id` the key that
`plan-reuse` matches a successor node to a predecessor run on, "assigned once, never regenerated" —
so if the Designer re-mints an `id` on a reorder, a rename, a reparent, or a paste, **every prior run
of that workflow silently loses its resume reuse.** Nothing fails at save time: the file validates,
the workflow runs, tests stay green. The damage surfaces only later, when someone resumes and watches
already-succeeded steps re-execute — and resume is at-least-once, so re-execution can re-fire external
effects. This ADR fixes who is allowed to mint an `id`, and the exact guarantee a save must hold, so
that failure cannot happen silently.

## Decision

**The Designer client mints ids; the server never generates or rewrites one.** A fresh
`crypto.randomUUID()` is stamped at node-create time, in the browser, into the in-memory edit model.
The write route ([#257](https://github.com/howardyang2009/PATH/issues/257)) validates the incoming
`id` shape (`IdSchema`) and the path confinement, and is otherwise a dumb sink: it does not stamp a
missing `id`, does not re-mint, and does not diff against the file on disk. This mirrors ADR 0006's
rejection of per-run auto-stamp write-back — the server does not mutate identity — and it is forced by
the canvas being a pure render of the workflow JSON (the id must exist in the client model the instant
a node appears, before any round-trip to the server). A server that stamped on write could not
distinguish a genuinely new node from one whose `id` the client dropped, so it would either re-mint
(the catastrophe above) or trust client ids anyway; a client trusted to *preserve* ids is already
trusted to *mint* them.

**The round-trip guarantee.** load → edit → save preserves the `id` of every node present in both the
loaded and the saved file, **unconditionally across rename, reorder, and reparent.** Identity is keyed
on the node's continuous existence in the edit session — never on its `name`, its position, or its
parent container. The only `id` changes within a session are: a new node (mint), a duplicate (a fresh
mint, below), and a delete (the `id` is retired with the node). The **workflow's own** `id` is
preserved on save on the same terms, and the file's name and path are provenance, not identity
(ADR 0006) — renaming or moving the file keeps the workflow `id`.

**Move versus duplicate.** A move or reorder carries the **same** `id`; a duplicate, copy-paste, or
cross-file paste gets a **fresh** `id` and a fresh file-unique `name`. The distinguishing principle:
identity follows the *original node object* through moves, while a duplicate is a *new* node object
seeded from another's content minus its `id`. Reusing a workflow across files is a `workflow` ref step
(a reference to another file's identity), not a copied node, so it raises no duplicate-id question.

**Malformed identity on open** (hand-written or pre-codemod files — the loader requires `id` today, so
these do not load through the normal path). Only an *absent* `id` is ever repaired; a *present* one is
never rewritten on import.

- **Absent** (including a file where only some nodes have ids, and including the workflow's own
  missing `id`): the Designer mints on import, marks the buffer **dirty**, and writes nothing to disk
  until an intentional save. This is an ordinary edit — it takes the [#258](https://github.com/howardyang2009/PATH/issues/258)
  lease on open and saves through the [#257](https://github.com/howardyang2009/PATH/issues/257) write
  route under the normal precondition; the only oddity is that the buffer is dirty from the moment it
  opens, which is correct: the Designer opened something the format did not accept and is proposing the
  repair, un-persisted until the author commits it.
- **Duplicate ids** (the same GUID on two nodes): the open is **refused** with an error naming the
  colliding pair. Silently re-minting one of the two is exactly the resume-breaking mutation this ADR
  exists to prevent; a human must decide which node keeps the `id`.
- **Invalid-format id** (present but not a UUIDv4): the open is **refused** with an error naming the
  node. An author who hand-typed a non-UUID may be encoding meaning; the Designer does not clobber it.

The write route additionally rejects a payload whose nodes carry **internally duplicate** ids — a
cheap guard against a broken client that needs no read of the prior file.

## How the guarantee is held and tested

Preservation is a **client invariant by construction**: the edit model stores each node's `id` and
writes it back, and there is no code path that regenerates an existing node's `id`. There is **no
server-side preservation backstop** — the server cannot compare a write against the prior file's
id-set without the read-and-diff this ADR rejects. The guarantee therefore rests on the client
invariant plus two named tests, the first of which is the non-delegable sign-off for #256:

1. **Golden round-trip** — load every repo `*.workflow.json` into the Designer model, serialize back
   with no edit, and assert the id-set is identical.
2. **Mutation-preserves-id** — rename, reorder, and reparent a node in the model, serialize, and
   assert every surviving node's `id` is unchanged and a duplicated node's `id` differs from its
   source's.

## Considered options

- **Server stamps ids on write (rejected).** Cannot tell a new node from one whose `id` the client
  dropped; re-mints or trusts client ids anyway. Also forces a read-back round-trip before the canvas
  can key on a node. Chosen alternative: client mints, server validates only.
- **Auto-stamp a missing `id` silently on open (rejected).** Silent identity mutation is the precise
  failure mode this ADR names, and it risks a stamp-then-autosave that rewrites the source file with no
  author intent. Chosen alternative: stamp on import but leave the buffer dirty and un-persisted.
- **Refuse to open any id-less file, defer to the codemod (rejected).** Hostile to hand-authoring,
  which is a stated Designer use case. Chosen alternative: repair *absent* ids on import.
- **Repair a duplicate or invalid `id` on import (rejected).** Both require choosing which of two
  nodes keeps an identity, or overwriting an author's deliberate string — decisions the tool must not
  make silently. Chosen alternative: refuse and name the offending nodes.

## Consequences

- **The Designer is safe to open on an arbitrary existing `workflow.json`** whose ids are valid: it
  round-trips them untouched. It is safe on an id-less file: it proposes a repair the author commits
  explicitly. It refuses only the two cases where a silent repair would either destroy resume history
  (duplicate) or an author's intent (invalid format).
- **The id-stability guarantee is the Designer's most consequential invariant**, and its failure is
  invisible at save time, so the golden round-trip test is a release gate, not a nicety.
- **A cross-file handoff lands on #257:** the read side must return the raw body of an id-less but
  otherwise-loadable file, rather than the loader hard-rejecting it before the canvas can offer the
  stamp-on-import repair.
- **The server write route stays identity-agnostic**, consistent with ADR 0006's stance that an
  ordinary write never mutates identity — the only sanctioned id-write remains authored in the client
  and committed by the author.
