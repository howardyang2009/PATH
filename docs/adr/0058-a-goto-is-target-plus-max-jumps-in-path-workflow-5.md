# A goto is `target` + `max_jumps` in `path/workflow@5`, checked by a schema rule module

**Status:** accepted. Resolves the schema grammar of the `goto` node for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#597](https://github.com/howardyang2009/PATH/issues/597); origin
[#478](https://github.com/howardyang2009/PATH/issues/478). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (execution model),
[ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) (pass scope),
[ADR 0055](0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md) (seeding),
[ADR 0056](0056-a-goto-names-its-target-by-step-name-checked-at-load-in-path-schema.md) (target by
name) and [ADR 0057](0057-controllers-split-into-structure-and-graph-kinds.md) (taxonomy). Plan-only:
no schema, codemod, engine or format-doc code yet — Consequences carries the hand-off.

ADR 0053 fixed what a jump *does* and 0056 how a file *names* its target. This ADR fixes how the
grammar *states* the node: its fields and their types, what is required, what an older engine does with
a file holding one, and where the placement rule is enforced.

Four facts shape it. `workflow-format-v3.md` §1: the declared `format` does not track the set of **step
types** — those are a registry fact, and a plugin-contributed type needs no codemod. `goto` is not that:
it is an engine-owned reserved member (ADR 0056 §5, ADR 0057), so it changes the grammar shape.
`workflow-format-v4.md` §0: `@4` bumped for one new *envelope* key, on the #501 rule that a grammar
change bumps even when it adds no new required data. A Step-Template body shares the file body grammar
and the same `FORMAT_VERSION` stamp (ADR 0048), so a bump moves the template stamp too. And the target
arrives as a **name** resolved at load (ADR 0056 §1), so no body ever holds a GUID cross-reference
(ADR 0049 §3 stands).

## Decision

1. **The node.** `goto` joins `buildCoreMembers` beside the six, and joins `RESERVED_TYPE_NAMES`, so no
   plugin folder may claim the name. Its shape is
   `{ "type": "goto", "id", "name", "target", "max_jumps" }` under `.strict()`. `target` is a
   `NameSchema` string (`^[a-z][a-z0-9-]*$`) and is required. `max_jumps` is required and is the
   `MaxIterationsSchema` union reused, not re-spelled: `z.union([z.number().int().positive(),
   interpolableString(STEP_ROOTS)])`.

2. **`max_jumps` is required, with an authoring default of 3.** ADR 0053 §5 says "an authored
   `max_jumps` on every goto node" and CONTEXT says mandatory, so nothing loads with an omitted bound:
   there is no engine fallback and no zod `.default()`. A parse-time default would be the first in the
   file grammar, and it would materialize a field into the parsed body that the author never wrote —
   while the Designer's clean/dirty relation is content equality against the save-point baseline
   (ADR 0030). The Designer pre-fills `max_jumps: 3` on insert and stubs `target: ""`, the `ref: ""`
   precedent, for the pane to fill. Interpolation roots are `STEP_ROOTS` (`config` + `context`),
   exactly as `max_iterations`, not `PUBLISH_ROOTS` or `CONDITION_ROOTS`.

3. **A target is any other first-level *node*, not only a Step.** ADR 0053 §3 refuses only an inner
   target and ADR 0056 §2 adds only self. Those are the whole rule: a first-level controller
   (`branch`, `sequence`, `while-do`, `parallel`, `checkpoint`) and another first-level `goto` are
   eligible targets, and a jump to either is a fresh entry that keeps one-visit-per-entry. "First-level
   step" in ADR 0053 §1 and CONTEXT was loose for "node"; both are amended. There is no fifth refusal
   case.

4. **Placement is legal in any node slot whose ancestor chain holds no `while-do` and no `parallel`.**
   That, and nothing narrower, is ADR 0053 §3: a first-level `branch`'s `arms[].node` and its `else`
   are one case, and any `sequence`/`branch` nesting below one is transparent. The rule is not "a
   first-level branch arm" as a special shape, and the `else` was always legal.

5. **One flat union; the whole rule is a load refinement.** `goto` is a syntactically legal occupant of
   every node slot in `makeNodeSchema`. The placement rule and the target rule live in a new
   `@path/schema` rule module that returns issues as **data** — `{ rule: "target-absent" |
   "target-inner" | "target-self" | "placement", nodeId, path, message }` — in the `publish-set.ts`
   pattern, called by `checkWorkflowFileInvariants` (ADR 0056 §5). One issue per offender, at the
   `target` field for the three target cases and at the goto node for placement (§4 of that ADR gives
   the wording). Nothing is structural: "first level" is a per-file notion, and a Step-Template body
   has no file namespace until it lands (ADR 0056 §6), so `makeBodySchema` stays permissive. The module
   carries `nodeId` from the start so the Designer's problem pass reads the same rule for its canvas
   marker, as it already does for `publishSetIssues`; #601 wires the marker. **Settled (#601):** see
   [designer-spec.md § `goto`: a jump without an edge](../spec/designer-spec.md).

6. **The format bumps to `path/workflow@5`.** `FORMAT_VERSION` moves; `SUPERSEDED_FORMAT_VERSIONS`
   gains an `@4` entry and appends `scripts/migrate-workflow-format-v5.ts` to the `@0`–`@3` chains. The
   codemod is a no-op format stamp that refuses nothing (the `@3`→`@4` precedent) and discovers all
   three suffixes — `*.workflow.json`, `*.step-template.json`, `*.workflow-template.json` — under the
   repo root and `.path/template/`, because the Step-Template envelope stamps the shared
   `FORMAT_VERSION` (ADR 0048 §1) and this repo ships three templates carrying `@4`. A `@4` engine
   meeting a `@5` file refuses the whole file at `format`; to make that legible the version pre-check
   becomes symmetric: a version number greater than the engine's gets `path/workflow@5 is newer than
   this engine reads (path/workflow@4) — upgrade PATH to read it`, rather than a bare zod
   invalid-literal. A malformed version string still falls through to the literal mismatch.

7. **Terminology: First level.** The position is the **first level** — a file's own top-level body, per
   file — and **Top-level walk** stays the walker that steps through it. CONTEXT gains a **First level**
   entry, and the Resume entry's "the top level of its own level's body" reads "the first level".

## Considered options

- **Reference the target by `id`.** Already rejected in ADR 0056; an id re-stamp (ADR 0049 §3) would
  dangle every goto.
- **Target a first-level *Step* only, with a fifth refusal for a controller target.** Rejected (3):
  ADR 0053 §3 and ADR 0056's closed list refuse inner and self only, and jumping back to a block is a
  legitimate loop shape. The word "step" was the defect, not the rule.
- **`max_jumps` optional, with an engine fallback of 3.** Rejected (2): CONTEXT and ADR 0053 §5 both
  say mandatory, and a fallback puts the bound's real default in the engine, where no author sees it.
- **`max_jumps: z.number().default(3)`.** Rejected (2): a parse-time default injects a field the author
  never wrote into parsed output, and the Designer's clean/dirty check is byte content against the
  save-point baseline (ADR 0030).
- **Keep `@4` and let the node union refuse the node.** Rejected (6): an older engine's refusal would
  read "unknown step type goto — … add a step-type plugin folder in your PATH tree", a remedy that is
  simply wrong for an engine-owned member. `format` is the mechanism that makes a version mismatch
  legible, and `@4` set the precedent that a grammar change bumps.
- **A second, goto-free node union for `while-do.node` and `parallel.branches`.** The one part of the
  rule a schema *can* express structurally. Rejected (5): it needs a fourth recursion slot, doubles the
  plugin members in the registry factory, and would push "first level" into a body fragment that has no
  file. One flat union plus one rule module is smaller and matches ADR 0056's accepted shape.
- **A load-refinement-only rule with no `nodeId`.** Rejected (5): the canvas must mark a misplaced
  goto, and `publish-set.ts` already carries `nodeId` for exactly that second reader.
- **A separate erratum ADR for the "first-level node" wording.** Rejected: this repo amends accepted
  ADRs inline (ADR 0018, 0019, 0020, 0021), so ADR 0053 and 0056 get `**Amended (#597).**` markers and
  this ADR references them.
- **Bundle other grammar changes into `@5`.** Rejected: nothing else is decided, and one format bump
  carries one change (`workflow-format-v3.md` §11).

## Consequences

- `packages/schema`: `nodes.ts` (`buildCoreMembers` and `RESERVED_TYPE_NAMES`; `ENVELOPE_KEYS` is
  untouched), `node-type.ts` (the `WorkflowNode` union gains `GotoNode`), `node-walk.ts`
  (`ControllerType` and `CONTROLLER_TYPES` gain `goto` — without it `isStepType("goto")` is true and
  reuse/rerun read a jump as a step — and `childBodies`/`mapChildBodies` gain the empty-child `goto`
  case their `never` guards force), `workflow-file-type.ts` (`@5` and the `@4` chain entry),
  `workflow-file.ts` (the invariants call the new module), the new rule module, and
  `scripts/migrate-workflow-format-v5.ts`.
- The "six reserved names"/"five controllers" wording in `nodes.ts`, `node-walk.ts`,
  `workflow-file.ts`, `designer/grammar.ts`, `designer/palette-data.ts`, `designer/open-workflow.ts`
  and `docs/format/workflow-format-v3.md` becomes seven reserved names and six controllers.
- The Designer palette gains `goto`; `node-factory.createNode` mints
  `{ type: "goto", …, target: "", max_jumps: 3 }`; the properties pane gets a target picker over the
  file's first-level names (its own excluded) and a `max_jumps` field beside `max_iterations`; a
  rename rewrites every `target` naming the renamed node (ADR 0056 §7). #601 owns only the depiction of
  the jump. **Settled (#601):** see [designer-spec.md § `goto`: a jump without an edge](../spec/designer-spec.md).
- The engine keeps ADR 0053/0054's `SeqOutcome.goto`, top-level walk and pass container; the schema
  delivers the node plus the `name → GUID` map the walk builds once per workflow-run (ADR 0056 §1).
- `CONTEXT.md` names the post-0058 format string: its three `path/workflow@4` stamps read
  `path/workflow@5`, its Goto entry says first-level **node**, and it gains **First level**.
  `docs/format/workflow-format-v5.md` (the delta: a seventh reserved member and its fields, the bump)
  and the v4 superseded banner belong to the build ticket, so no banner ever links a missing document.
- Hand-off: the build ticket owns schema, codemod, format doc, engine wiring and Designer authoring;
  #598–#601 keep their own scopes; #602 synthesizes.
- Verification: a `@5` file holding a `goto` loads; the same file on a `@4` engine reports the
  newer-format message; a goto under `while-do`/`parallel` and an absent, inner or self target each
  fail with one issue at the right path; a goto-free `@4` file restamped by the codemod is byte-identical
  but for `format`.
