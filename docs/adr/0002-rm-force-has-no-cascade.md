# `path runs rm --force` overrides the live-reuse-marker block; it does not cascade

Status: accepted

[ADR 0001](0001-resumed-run-is-a-successor-run.md) requires `path runs rm <root-run-id>` to block by
default when a live successor tree holds a reuse-marker that back-references the tree being deleted.
This ticket ([#164](https://github.com/howardyang2009/PATH/issues/164)) fixes the escape hatch's shape.
It is a single `--force` flag that deletes only the named tree and leaves the blocking successors with
a now-dangling reuse-marker, rather than a cascade that also deletes the successors.

## Considered Options

- **Cascade delete.** `--force` (or a separate `--prune` flag) would also delete every live successor
  that blocks the target, so no dangling reference is ever left behind. Rejected: this reaches into
  trees the operator never named on the command line, a larger blast radius than `rm` has ever had.
  `rm` was already hardened once to reject a second bare operand (#61: a second id used to be dropped
  in silence, which deleted one run while the operator believed both were gone), specifically to keep
  it from a touch of more than the one tree it was told to. A flag that silently deletes *other* trees
  reopens the same failure shape #61 closed, at a larger scale.
- **`--force`, no cascade.** Chosen. It deletes exactly the tree named, nothing else. The dangling
  reuse-marker it leaves behind is the same category of accepted risk that the "lying `running` rows"
  already are elsewhere in this door (resume-door-verdict.md §5): a disclosed, operator-chosen
  consequence, not a silent one.

## Consequences

- A forced delete must name every successor it just orphaned in its own output (not just on the blocked
  path), because the dangling reference it creates is otherwise invisible until something later reads a
  dead reuse-marker.
- A future cascade option, if ever wanted, is additive: a new flag, not a change to `--force`'s
  existing meaning.
