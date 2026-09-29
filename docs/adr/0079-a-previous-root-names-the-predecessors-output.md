# A `previous` root names the predecessor's output, and `output` means only a step's own output

**Status:** proposed. Tracks [#681](https://github.com/howardyang2009/PATH/issues/681). Partly
supersedes decision 5 of
[ADR 0055](0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md) ("no new
interpolation root"); its pass-through seeding (decisions 1–4) stands and gives `previous` its value
after a jump.

A node's predecessor output reaches it today in two ways, and neither can name it clearly:

- **As a default input.** A step with no `input` map receives the predecessor's output object as its
  input (format §6.1, `run-node.ts`). A step that writes an `input` map loses that object completely:
  `STEP_ROOTS` is only `config` + `context`, so the map cannot read one field of it. The workaround is
  two moves: the predecessor `publish`es the field into context, and the step reads `${context.x}`.
  Every such field then also sits on the run-wide blackboard, where a `goto` pass or a `while-do`
  iteration can overwrite it (ADR 0059).
- **As a condition root named `output`.** In a `branch` arm's `when`, a `checkpoint`'s `condition`
  and a `while-do`'s `condition`, `output` is the predecessor's output. In a `publish` map, `output`
  is the step's **own** output. One word has two meanings. The shipped `person-switch` template shows
  the cost: authors read `output.choice` in the branch as the branch's own output, and try
  `input.choice`, which is not a root anywhere and fails at load.

## Decision

1. **`previous` is the output object of the node that ran just before this node in the walk.** It is
   the same value the engine already passes as the incoming output (`incomingOutput`), so the
   default-input chain of format §6.1 defines it in every position:

   | Position | `previous` is |
   | --- | --- |
   | after any node in a sequence or at the first level | that node's output object |
   | first node of a branch arm, a `parallel` branch, or a `while-do` body | the block's predecessor's output (parallel siblings share one snapshot) |
   | `while-do` iteration N > 1 | iteration N−1's output |
   | `goto` target | the goto's passed-through output (ADR 0055), never the skipped lexical predecessor |
   | first node of a workflow-run | the workflow-run's input object |

2. **A step's input follows one rule.**
   - **No `input` map:** the step's input is `previous`, unchanged. This is today's behavior, now
     with a name.
   - **An `input` map:** the map builds a new object for this step. Its values interpolate over
     `config`, `context` and `previous`. `"${previous}"` alone is the whole object; `"${previous.x}"`
     picks one field. Nothing of `previous` reaches the step unless the map names it.

3. **Roots per position, one word per meaning.**

   | Position | Roots |
   | --- | --- |
   | step `input` map (`STEP_ROOTS`) | `config`, `context`, `previous` |
   | `when` / `condition` (`CONDITION_ROOTS`) | `context`, `previous` |
   | step `publish` map (`PUBLISH_ROOTS`) | `config`, `context`, `output` |

   `output` is the step's **own** output, and is readable only in `publish`. `input` stays a field an
   author writes, never a root a path reads. Positions not in this table (the workflow `output` map,
   `max_iterations`, `max_jumps`) keep their roots.

4. **Two phases.**
   - **Phase A, additive, inside `path/workflow@5`.** Add `previous` to `INTERPOLATION_ROOTS`,
     `STEP_ROOTS` and `CONDITION_ROOTS`. `output` stays legal in conditions as a deprecated name for
     the same value, so every existing file still loads.
   - **Phase B, `path/workflow@6`.** Remove `output` from `CONDITION_ROOTS`. The `@5` to `@6`
     migration rewrites `output` and `output.*` in `when.path` and `condition.path` to `previous` and
     `previous.*`, including the shipped `person-switch` step-template and the repo examples. After
     Phase B, `output` in a condition fails at load and names `previous` in its message.

## Considered Options

- **Keep today's names.** Rejected: `output` keeps two meanings, and a step with an `input` map still
  cannot read its predecessor's output without a context round trip.
- **An `input` root in conditions.** Rejected: a branch, checkpoint or while-do has no input object
  (invariant 3 is about steps), and `input` is already the name of the field an author writes. The
  root would name a thing the node does not have.
- **Keep `output` and `previous` as permanent aliases in conditions.** Rejected: two names for one
  object re-create the ambiguity this ADR removes. Phase A allows the alias only until `@6`.
- **Rename to `preoutput`, `prev` or `incoming`.** Rejected: `previous` is a plain word, reads well as
  `${previous.choice}`, and is the name ADR 0055 already weighed. `incoming` is the engine's word, not
  the author's.
- **Make the whole-object default explicit, and require `"input": "${previous}"`.** Rejected: it adds a
  line to every step for today's default, and breaks every file for no gain in meaning.

## Consequences

- **The context round trip becomes optional.** A step reads a predecessor field with
  `${previous.x}`. `publish` stays the way to share a value with a node that is not the next one, or
  with a later pass or iteration.
- **Designer suggestions need the predecessor's shape.** `referenceablePaths` must find the
  predecessor's `outputSchema` from the node's position, with the table in decision 1, including arm
  first nodes and goto targets. When no schema is known (a goto target with several gotos, a step
  with no `outputSchema`), the pane accepts any `previous.*` path and does not suggest one.
- **Secret masking covers the new root.** `secret-mask.ts` and condition traces mask `previous` as
  they mask `output` now.
- **Resume and Complete need no new seeding.** A re-entered step already receives its recorded
  incoming output, which is `previous`. A test pins `${previous.x}` in an `input` map across a Resume
  and across a backward `goto`.
- **ADR 0055 decision 5 is replaced for steps and conditions.** Goto still carries no input of its
  own; `previous` only gives a name to what the goto already passes through.
- **Docs change with Phase A:** `CONTEXT.md` gains a **Previous** entry, format §6.1 and §6.6 list the
  new root, and §9 conditions name `previous`. Phase B bumps the format document to `@6` and archives
  `@5`.
