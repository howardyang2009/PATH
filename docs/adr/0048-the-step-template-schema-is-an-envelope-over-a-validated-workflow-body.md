# The Step-Template schema is an envelope over a validated workflow body

**Status:** accepted (amended to clarify that `format` versions the body grammar, not the envelope; see
decision 1 and the rejected `path/step-template@1` option); resolves the schema decision of Wayfinder map
[#558](https://github.com/howardyang2009/PATH/issues/558), ticket
[#561](https://github.com/howardyang2009/PATH/issues/561) ("Finalize `.step-template.json` schema"). It
fixes the artifact format every other ticket in the map reads: instantiation
([#562](https://github.com/howardyang2009/PATH/issues/562)), the template API
([#563](https://github.com/howardyang2009/PATH/issues/563)), and the Designer palette
([#564](https://github.com/howardyang2009/PATH/issues/564)). It builds on
[#559](https://github.com/howardyang2009/PATH/issues/559) (a `@2` body fragment holds no GUID
cross-references) and the map's settled forks (Template is not a step-plugin; detached-copy
instantiation; shipped under `packages/server/template/step-template/`, user under
`.path/template/step-template/`). The glossary terms are `CONTEXT.md` § Templates.

A `.step-template.json` is inserted into someone else's workflow file, so its format has to answer two
questions before any code exists: what is the artifact's envelope, and **what exactly is checked when
the Server loads it**. The second is the load-bearing one, because a fragment cannot know the file it
will land in.

## Decision

**A Step-Template is a strict envelope around a body that validates exactly as a workflow file's body
does.**

1. **Envelope** — `{ format, id, description, body }`, `.strict()`.
   - `format` is **`"path/workflow@4"`** — the *current* `FORMAT_VERSION`, not `"path/workflow@2"`.
     "`@2`" names the **body grammar** this map's tickets discuss (uniform single-node container slots,
     a flat node array at the file body, `sequence` where several nodes are needed in order); it is not a
     loadable format string, and a file stamped `@2` is today rejected by the superseded-format path with
     a codemod message. The body *is* `@4` grammar, so one version space and the existing
     superseded-format machinery work unchanged. The `format` field therefore versions the **body
     grammar**, not the envelope: the envelope shape `{ format, id, description, body }` is frozen and
     carries no version of its own, and the artifact's **kind** is the file suffix's job
     (`*.step-template.json`), typed by the Template store never by bytes (ADR 0050). That is why the
     stamp is `path/workflow@N` rather than a step-template-specific string — there is exactly one
     grammar to gate at load, the body, and it is the workflow body. A distinct `path/step-template@1`
     was considered and rejected (below).
   - `id` is the template's own GUID (`IdSchema`, UUIDv4) — its identity, written once when the template
     is created. It is never re-stamped, because a template is not instantiated; only its body's nodes
     are copied.
   - `description` is a required non-empty string: the artifact's one human-readable datum, and the
     palette blurb the Designer renders. Required rather than optional because a template with nothing
     to say about itself is not findable in a list.
   - **There is no `name` field.** The file stem *is* the name (`^[a-z][a-z0-9-]*$`, `NameSchema`),
     exactly as a step-plugin folder's name *is* its type name. One source of truth, and a rename is a
     file rename.
2. **`body` is `WorkflowNode[]`, minimum length 1** — the same shape and the same minimum as a workflow
   file's body. Not a single node, not a `{nodes, controllers}` wrapper, not a `WorkflowNode | WorkflowNode[]`
   union: one shape means the template validator is literally the file body's constraint, and a one-node
   template is `body: [node]`.
3. **Controllers are legal at the fragment's top level.** `parallel`, `branch`, `while-do`, `sequence`,
   and `checkpoint` are all ordinary `WorkflowNode`s, and a fragment is a node array. `checkpoint`
   inherits the grammar's *existing* restriction (legal only in a sequence-flavoured list) rather than
   gaining a template-specific one. Where a fragment may be inserted is
   [#562](https://github.com/howardyang2009/PATH/issues/562)'s rule, not the format's: a fragment with a
   top-level `while-do` is a valid template that simply is not insertable everywhere.
4. **Default property values are inline.** The nodes in `body` are **real, valid `@2` nodes carrying
   their default values in their own declared fields** — a `prompt` template ships
   `prompt: "Review this diff"` and `config: { model: "…" }` as ordinary node data. Consequence, stated
   so it is a decision and not an accident: **a template's default values are the values its nodes
   actually hold**, so the template is a literal parameterized snippet, and instantiation copies it and
   touches no field but `id`.
5. **Validity is per-node, registry-relative, and nothing else.** A template is valid iff every node of
   `body` validates against `makeNodeSchema(registry)` — the node union and each type's own
   `fields`/`config` fragment and `worker` enum. The checks the *file* loader runs beside that are
   deliberately **not** run at template load:
   - **name uniqueness** — not checked. The template's node names will be resolved against the target
     file's namespace at insert ([#562](https://github.com/howardyang2009/PATH/issues/562)), the way any
     new node's name is; a fragment cannot know that namespace.
   - **publish-set legality** — not checked. A `collect` sibling-race or a `do-not-wait` publish is a
     collision with siblings that do not exist yet; the check re-runs on the target file when the
     fragment lands.
   - **no node-count bound** — not checked. The 1–2 node guideline of
     [#459.1](https://github.com/howardyang2009/PATH/issues/459) is **advice, not a validity rule**: a
     template may be arbitrarily complex, nesting blocks to any depth, and a
     [#564](https://github.com/howardyang2009/PATH/issues/564) surface may mark a large one as large.
     Encoding it in `@path/schema` would make a shipped template's loadability depend on a design
     opinion, and the guideline counts top-level nodes, which one `sequence` node evades anyway.
   - **no `worker_defaults`** — the key does not exist in the envelope. A `worker_defaults` table is
     file-scoped and live, re-read from the current file; a template that rewrote its target's table
     would be the live-link behaviour this map rejected. A template that wants a specific worker writes
     `worker` on the node, which is already a per-node selection.
6. **A `workflow` (sub-workflow ref) node is legal in a template body**, and its relative `ref` resolves
   against the **target** file's directory. This is deliberate and it is the one place the format leaves
   an author a rope: a template's own directory is irrelevant to its nodes' meaning, so a template
   carrying `ref: "child.workflow.json"` names a file that must exist beside whatever workflow it is
   inserted into. The template loader does **not** check that the file exists — a `@4` file's `ref` is
   never existence-checked at any door, and adding such a check here would be a target-scope check
   decision 5 rules out. Stated as a decision so a later reader does not "fix" it into a load error, and
   so [#562](https://github.com/howardyang2009/PATH/issues/562) can decide what the insert surface
   *shows* about a dangling ref without the format having to refuse it.
7. **The format lives in `@path/schema`**, as `StepTemplate` plus `makeStepTemplateSchema(registry)` and
   `safeParseStepTemplate(json, registry)`, beside `WorkflowFile`. To make decision 5 true rather than
   aspirational, the existing file loader is **refactored into the body schema it should always have
   been**: a new exported `makeBodySchema(registry)` owns `z.array(nodeSchema).min(1)` and the
   body-scoped identity walk, and `makeWorkflowFileSchema` is built on it, so the file's body and a
   template's body are one constraint that cannot drift. `checkWorkflowFileInvariants` splits along the
   same line: the body-scoped part (identity) belongs to the body schema, the file-scoped part
   (`worker_defaults`) stays with the file. The `@path/engine` grows no template reader — the engine
   never registers nor executes a template.
8. **An invalid template is invalid alone.** Discovery reports that one template with its error and
   every other template still lists; the Server does not fail to start. A template is *data the Server
   reads*, not *code it loads*: a broken step-plugin folder throws at import and must take the process
   down, while a broken JSON artifact is the ordinary per-file invalidity channel
   ([ADR 0026](0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md)).

## Considered options

- **A separate defaults table (`fieldDefaults` / `configDefaults`) with placeholder nodes.** Rejected:
  it needs a resolution algebra and a reserved key that does not exist (a step type's `fields` is
  `.strict()` per type, and `config` is `.passthrough()`, so a `defaults` key on a node is rejected and
  a keyed table merely duplicates the tree in a second grammar). Inline values make the template a
  valid workflow body, which is what lets one validator serve both.
- **Removing the inner node `id`s so a fragment is an "identity-less" grammar.** Rejected: it invents a
  second body grammar and makes `makeNodeSchema` unusable, since every downstream reader — `childBodies`,
  `publishKeysOf`, the whole Designer canvas — assumes `id` exists. The template body's node ids are
  therefore *authoring* ids, always re-stamped on insert; the durability loss is one sentence, not a
  shape.
- **Requiring a top-level `sequence` wrapper, or refusing top-level controllers.** Rejected: a fragment
  like `[person-activity, branch]` is exactly what a Step-Template is for, and a `while-do` bundle is a
  legitimate one. The insert-socket rule (#562) is where placement belongs; the format should admit
  everything the block grammar admits.
- **Stamping the template `"path/workflow@2"`, as this map's tickets phrase it.** Rejected — it is not a
  loadable format string. Nothing needs `@2` here: `@3` changed `worker` to a name and moved
  `model`/`options` into `config`; `@4` added the file-level `worker_defaults` and the `input` seed,
  neither of which a fragment uses.
- **A step-template-specific format string (`path/step-template@1`).** Rejected — it would version the
  envelope, but the envelope has no grammar of its own to gate; the only thing checked at load is the
  body, which is a workflow body and must track `path/workflow@N`. The artifact's kind is already the
  file suffix (`*.step-template.json`), typed by the store never by bytes (ADR 0050), so a kind-naming
  format string duplicates the suffix, and a separate version ladder would leave the body grammar
  version untracked — the reverse of what the load-bearing check needs. If the envelope shape ever gains
  or drops a key, that is a change to `makeStepTemplateSchema`, not a `format` bump.
- **A hard 1–2 node bound.** Rejected (decision 5).
- **A template-level `worker_defaults`.** Rejected (decision 5).
- **Forbidding `workflow` ref nodes in a template body, because a relative `ref` is broken by the copy
  into a different directory.** Considered seriously and refused: it would be a *structural* rule where
  decision 5's contract is per-node, it is stricter than any door applies to a hand-authored `@4` file,
  and resolving-against-the-target is coherent if the author means it (a template intended to be
  inserted beside a known child file). Recorded as decision 6 with its cost named.
- **A `name` field in the envelope, asserted equal to the file stem.** Rejected in favour of deriving
  the name from the stem outright, as a plugin folder's name is its type name: a stated assertion where
  a derivation will do is a second source of truth.

## Consequences

- **The template format is frozen.** Shipped templates and user-saved ones both carry
  `{format, id, description, body}`, with `format` stamping the current body grammar (`@4`). Because
  `format` versions the **body**, a change to the *body grammar* bumps `path/workflow@N` and rides the
  superseded-format path; the **envelope** shape is frozen and unversioned — a new envelope key is a
  schema change to `makeStepTemplateSchema`, not a `format` bump — and the artifact kind stays the
  suffix's, not the format string's.
- **`@path/schema` gains an exported body validator**, and `makeWorkflowFileSchema` is rebuilt on it.
  This is the refactor that makes "the template's body is validated exactly as a file's body" literally
  true rather than a comment: one `z.array(nodeSchema).min(1)`, one identity walk.
- **The Server's loader is thin.** It reads the file, checks the `format` stamp, asserts the stem matches
  `NameSchema`, and delegates the body to `makeStepTemplateSchema(registry)`. No template-specific
  validation logic exists to drift.
- **The Designer's palette has an honest invalidity story.** Every registry-described type inside every
  valid template resolves; a template naming a type this tree lacks is reported invalid and marked
  unavailable, the same stance a workflow file takes (registry-relative validity), so the palette never
  lists an insertable template that would fail on insert.
- **`worker` selection is per node and only per node.** A template author who wants `deepseek` writes
  `worker: "deepseek"` on the prompt node; nothing at the file level is touched on insert.
- **The one rope is a relative `workflow` ref** (decision 6). A future ticket may decide the insert
  surface warns about a dangling ref; the format will not refuse it.
- **This ticket writes no production code.** The output is this ADR, the `CONTEXT.md` § Templates terms,
  and the decision comment on [#561](https://github.com/howardyang2009/PATH/issues/561). The build
  session implements the schema, the loader, the routes, and the palette.
- **Acceptance.** A `person-activity` + `branch` template loads and is valid; a template naming an
  unregistered step type is reported invalid by discovery while other templates still load; a template
  whose two nodes share a `name` loads (names are resolved at insert); a template with a `collect`
  sibling publish-key collision loads (publish checks are the target file's); a 12-node template loads;
  a template carrying `worker_defaults` is rejected by `.strict()`; a `@2`-stamped template is rejected
  with the codemod message; a template whose stem does not match `NameSchema` is rejected; a template
  whose `description` is missing or empty is rejected.
