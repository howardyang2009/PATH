# `person-switch` is a shipped step-template, not a controller

**Status:** accepted; supersedes
[ADR 0047](0047-person-switch-is-a-controller-with-an-authored-activity-and-labelled-slots.md).
Resolves the person-switch model for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544) and origin
[#477](https://github.com/howardyang2009/PATH/issues/477), reversing the controller model once the
Step-Template feature ([#558](https://github.com/howardyang2009/PATH/issues/558), ADR 0051) made a
bespoke controller unnecessary.

`person-switch` was going to be a new **Graph Controller**: a worker-less reserved type holding an
authored selection leaf and labelled child slots (ADR 0047). That is no longer how we build it.

## Decision

**`person-switch` is a shipped Step-Template that composes two primitives PATH already has: a
`person-activity` leaf and a `branch` controller. It is not a controller and adds no engine type.**

Its behaviour (#477) is: reach **Awaiting**, let a person pick which of several nodes runs next, run the
picked node, then succeed. That decomposes exactly:

1. A **`person-activity`** node (the *ask*), whose `outputSchema` is a JSON Schema string enum of the
   labels. Its Complete records the person's choice as an audited, `ajv`-validated value (ADR
   0038–0043), so Awaiting is still reached by a real leaf and ADR 0038 (Awaiting is leaf-only) needs no
   amendment.
2. A **`branch`** controller keyed on that value, its arms the selectable nodes. The branch outputs the
   chosen arm's output; the enclosing `sequence` [ask, branch] outputs the branch's output and succeeds.
   Invariant 1 holds because `branch` is an ordinary controller with no worker or run of its own.

This is the "human routing is **data + a pure declarative condition**, not a direct edge pick" finding
of the prior-art research ([#547](https://github.com/howardyang2009/PATH/issues/547)).

Because the pattern is ordinary `path/workflow` nodes, it ships as a **Step-Template** (ADR 0051): a
Server-owned, engine-blind authoring artifact at
`packages/server/template/step-template/person-switch.step-template.json` that expands into
`person-activity` + `branch` before any run. The engine never gains a `person-switch` type.

## Considered options

- **A worker-less `person-switch` controller** (ADR 0047, now superseded). Added a reserved type, a
  labelled-children grammar, and a bespoke selection act, all to express what `person-activity` +
  `branch` already express. The Step-Template feature made it redundant.
- **A `person-switch` leaf step-type plugin** (option A of #545). Still rejected: it would push routing
  into a worker.

## Consequences

- No new engine type, no schema grammar, no new run kind for `person-switch`.
- The selection act, children shape, and output contract (#552, #553) dissolve into `person-activity`'s
  Complete and `branch`'s arms/output. Those tickets are closed as subsumed.
- `goto` is now the **sole Graph Controller**; the Structure-vs-Graph taxonomy (#555) reflects that.
- `person-switch`'s convenience is authoring, not execution: a user drops the step-template in and edits
  it like any other snippet, and can freely change the labels, the ask, or the arms afterwards.
