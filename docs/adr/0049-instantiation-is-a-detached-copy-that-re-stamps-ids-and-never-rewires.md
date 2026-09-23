# Instantiation is a detached copy that re-stamps every id and never rewires

**Status:** accepted; resolves the instantiation decision of Wayfinder map
[#558](https://github.com/howardyang2009/PATH/issues/558), ticket
[#562](https://github.com/howardyang2009/PATH/issues/562) ("Instantiation algorithm spec (detached
copy)"). It builds on [ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)
(the `.step-template.json` envelope over a validated body), [ADR 0006](0006-workflow-and-node-identity-guid-plus-name.md)
(the `id`=GUID / `name`=human split and the root run's source-workflow identity),
[ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md) (the client mints ids, the
server never rewrites them, a save preserves every id), and [#559](https://github.com/howardyang2009/PATH/issues/559)
(a `@2` body fragment holds no GUID cross-references). The glossary terms are `CONTEXT.md` § Templates
(**Instantiation**, **Template instance**, **Template edit mode**).

A **Template** is Server-owned and engine-blind: it expands into ordinary nodes *before* any run, and
the engine sees only those nodes. So the one algorithm that turns a template into nodes is not the
engine's; it is the Designer's, and its whole job is to produce a fragment indistinguishable from a
hand-authored one. This ADR fixes what that transform does, where it lives, and the two places its
verbatim copy has a sharp edge.

## Decision

**Instantiation is a pure detached-copy transform of a template body, owned by `@path/schema` and
called by the Designer client.** No back-link is created in either direction (the map's settled fork,
against live-link/component instantiation); editing a template never propagates to an instance and
editing an instance never propagates back.

1. **Locus.** The transform is a pure function in `@path/schema` (a `WorkflowNode[]` in, a fresh
   `WorkflowNode[]` out), and the Designer is a thin caller. It is not engine code — the engine never
   registers nor executes a template — and it is not server code: the Server serves the template bytes,
   the client instantiates. Putting it in `@path/schema` beside the tree walks it already owns
   (`childrenByParent`, `subtree`, `publishKeysOf`) makes it unit-testable without a browser and keeps
   the client a thin caller, the same split ADR 0048 drew for the body validator.

2. **Re-stamp every id, drop the envelope id.** Deep-copy the body and mint a fresh `crypto.randomUUID()`
   `id` on **every** node, recursively — leaf steps, container nodes (`parallel`, `branch`, `while-do`,
   `sequence`, `checkpoint`), and every branch arm, since each carries its own `id` (ADR 0006, `@2`
   §4.3). This is the client minting ids at create-time, exactly the authority ADR 0015 grants it. The
   template's envelope `id` is **not** copied into the workflow: that GUID is the template's own identity
   (ADR 0048), and a template is not instantiated, only its body's nodes are. A `workflow`-ref node gets
   a fresh node id but keeps its `ref` string verbatim.

3. **No rewiring.** Every datum other than the node `id` is copied verbatim — values, `config`, `parse`,
   `publish`, `condition`, and each `workflow` `ref`. This is legal precisely because a `@2` body
   fragment holds **no GUID cross-references** (#559): all intra-body wiring is value-level (config /
   context / output dot-paths, publish keys) or name-level (parallel branch names), none of it keyed on
   the ids we just re-stamped. A re-stamp that touched only ids therefore needs no compensating rewrite.

4. **No defaults pass.** The transform materializes nothing. A template's "default property values" *are*
   the values its own nodes hold (ADR 0048, #561 — inline on the nodes, no defaults table), so the copy
   already carries them. Step-type field defaults, worker-default resolution, and config defaults stay
   the engine's registry-relative run-time job; instantiation is a pure structural copy plus an id
   re-stamp, and touches no type-level default.

5. **Names: verbatim until collision, then `uniqueName`.** Node names are copied verbatim, *except* a name
   that collides with one already used in the target file is resolved the way any new node's name is —
   `uniqueName` reserves `name`, then `name-2`, `name-3`, … (`packages/designer/src/node-factory.ts`).
   The Designer keeps names file-unique by construction even though the schema imposes no uniqueness
   (#561). The `used` set is the target file's names plus the names already assigned earlier in the same
   insert, walked in deterministic pre-order. No `-copy` suffix: that is for an explicit in-file
   duplicate, and an instance is not a duplicate of any node the file already holds.

6. **Insert socket.** The body is `WorkflowNode[]`, minimum length 1 (ADR 0048). A 2+-node body dropped
   into a `@2` single-node container slot (ADR 0014) is wrapped in a fresh `sequence`; a one-node body
   inserts bare; at the file-body top level or inside an existing `sequence` the nodes splice in
   directly. The Designer edit-tree checks the drop target's grammar-legality client-side and refuses an
   illegal drop; the block grammar (ADR 0029) is the only placement authority, so no run-time check
   exists.

7. **Workflow-Template instantiation is the same transform plus a workflow-level re-mint.** Selecting a
   `*.workflow-template.json` into an empty canvas (a buffer whose body holds zero nodes) runs the
   detached copy over the whole workflow and additionally mints a **fresh workflow `id`**, because two
   workflows spawned from one template must not share a source-workflow identity — that trio groups a
   root run's provenance in the store (ADR 0006), and a shared id would merge unrelated runs. The
   template's own workflow id stays the template's. The file-level `input` and `worker_defaults` ride
   across verbatim (authoring content), and the new name/path come from the save-as dialog (provenance,
   not identity). The resulting instance is saveable **only** to a `*.workflow.json` (#460.3).

8. **Two save modes, discriminated by the suffix on open.** Where a save of template content lands
   depends on how the template reached the canvas. **Consume mode** — selected from the palette into an
   empty canvas — yields an instance whose default Save writes a `*.workflow.json`, and which becomes a
   template again only through an explicit "Save as template" (#459.6). **Author mode** — the
   `*.workflow-template.json` file itself opened to edit the template source — is ordinary file editing
   under the ADR 0015 round-trip, so its default Save writes back to the original template file with the
   workflow `id` preserved; a Save-As to a new `*.workflow-template.json` mints a fresh workflow `id`
   (two templates must not share identity); and a "Save as workflow" runs instantiation to a
   `*.workflow.json`. This ADR fixes the model; author-mode save is *built* on the template write-route
   and palette work (#563, #564).

## Considered options

- **Re-stamp ids *and* rewire references, to be safe (rejected).** #559 already established there are no
  GUID cross-references to rewire, and value/name-level wiring is internally consistent after a verbatim
  copy. A rewiring pass would be dead code guarding against a reference class the `@2` grammar does not
  contain, and it would need a resolution algebra the format deliberately avoids.
- **Keep colliding names verbatim, letting duplicate names stand (rejected — the Q3 (a) option).** The
  schema permits duplicate names (#561), so this is *representable*, but the Designer's whole model keeps
  names file-unique (`node-factory.ts`), and `name` is the `collect`/`wait-one` output key and a
  value-level reference target — two nodes named `check` in one file is a latent wiring ambiguity, not a
  convenience. Chosen instead: uniquify on collision like any new node, and accept the one hazard below.
- **Uniquify on collision *and* rewire the intra-body references to the renamed node (rejected — the Q3
  (b) option).** It re-introduces exactly the rewiring pass #559 let us delete, to repair a break that
  only occurs when a name-referential template lands in a file already holding the colliding name. The
  cost of the general machinery outweighs the narrow case; the break is documented instead.
- **A separate defaults pass that materializes type/worker/config defaults onto the copied nodes
  (rejected).** It duplicates, at authoring time and in a second place, a resolution the engine already
  performs at run time against the live registry, and it would freeze a default that the registry is
  meant to own. The nodes carry their authored values; the engine supplies the rest at run.
- **Instantiate on the Server, or in the engine (rejected).** The engine is blind to templates by the
  map's central fork, and the Server serving bytes while the client mints ids is ADR 0015's exact stance
  — a server that stamped ids could not tell a fresh node from one whose id a client dropped. Client-side
  instantiation over a pure `@path/schema` transform keeps both invariants.
- **One save target for a workflow-template, "always save to a workflow" (rejected).** It reads #460.3
  too literally and makes a template un-editable: an author who opens a template to fix it could only
  fork it into a workflow, never correct the source. Distinguishing consume mode from author mode by the
  file suffix keeps #460.3 for the *instance* while letting the *source* be edited.

## Consequences

- **The transform is a pure function with two golden tests.** Its correctness is a `@path/schema` unit
  concern: an instantiate of a nested body re-stamps every id at every depth and leaves every other byte
  equal, and a second instantiate of the same body yields a disjoint id-set. No browser, no engine, no
  server is in the loop.
- **Instantiation and ADR 0015's paste are the same shape.** A cross-file paste already mints fresh ids
  and a fresh file-unique name (ADR 0015); a template insert is that operation with the source being a
  template body rather than a clipboard node. The Designer has one node-arrival mechanism, not two.
- **Two named hazards ship in the spec, not in code.** A uniquified name breaks any intra-body
  value-level reference to it — a downstream `context.<name>...` dot-path or a cross-block read of a
  renamed branch's `collect`/`wait-one` key — because instantiation does not rewire (decision 3). And a
  relative `workflow` `ref` re-resolves against the target file's directory (ADR 0048 decision 6), so a
  copied `ref` can point elsewhere when the template and target directories differ. Both are limitations
  an insert-surface ticket may later warn about; neither is refused.
- **This ticket writes no production code.** The output is this ADR, the `CONTEXT.md` § Templates terms
  (**Instantiation**, **Template instance**, **Template edit mode**, and the fresh-workflow-id note on
  **Workflow-Template**), and the decision comment on [#558](https://github.com/howardyang2009/PATH/issues/558).
  The build session implements the transform in `@path/schema`, the insert socket and drop-legality in the
  Designer edit-tree, and (with #563/#564) the two save modes.
- **Acceptance.** Instantiating a `person-activity` + `branch` template into a workflow yields two nodes
  with fresh ids and the authored names, the branch check string still matching the activity output
  string (a value match, untouched). A template whose node name equals an existing file node's is
  inserted as `name-2`. A two-node template dropped into a single-node slot lands wrapped in a fresh
  `sequence`; the same template spliced into the file body lands as two bare nodes. Instantiating a
  workflow-template into an empty canvas produces a workflow with a fresh workflow id, fresh node ids, and
  the template's `input`/`worker_defaults` intact. Opening a `*.workflow-template.json` in author mode and
  saving writes back to the same file with its workflow id unchanged; "Save as workflow" produces a
  `*.workflow.json` with a fresh workflow id.
