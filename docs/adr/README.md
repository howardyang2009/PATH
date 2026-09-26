# Architecture decision records

An Architecture Decision Record (ADR) records one decision PATH has made: the shape chosen, the alternatives weighed, and why the choice won. This index lists every decision with its current status, so a reader can tell at a glance what still governs the code and what has been replaced. The ADRs are the rationale, not the specification; the current behavior lives in [`CONTEXT.md`](../../CONTEXT.md) and the reference docs under [`docs/`](../). A superseded ADR is kept for the record and is not rewritten to match the decision that replaced it.

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-resumed-run-is-a-successor-run.md) | Resumed runs are successor runs, not the same root run mutated in place | accepted |
| [0002](0002-rm-force-has-no-cascade.md) | `path runs rm --force` overrides the live-reuse-marker block; it does not cascade | accepted |
| [0003](0003-context-seed-path-for-path-run.md) | `path run` gains `--context`/`--set-context`; combining either with `--resume` is a hard error | accepted |
| [0004](0004-wait-one-resume-short-circuit.md) | `wait-one` resume re-evaluates the join; a reused winner short-circuits its losers | accepted |
| [0005](0005-path-run-dash-c-is-store-only.md) | `path run -C <dir>` relocates the `.path` store only; it does not re-root the workflow path | accepted |
| [0006](0006-workflow-and-node-identity-guid-plus-name.md) | Workflow and node identity: a durable GUID `id` plus a human `name` | accepted |
| [0007](0007-workflow-format-v1-audit-node-name-output-keyed-by-name.md) | Workflow format `@1`: audit carries `node_id`=GUID + `node_name`, block output keyed by name | accepted |
| [0008](0008-do-not-wait-detached-failure-does-not-fail-tree.md) | A `do-not-wait` detached branch failure does not fail its tree | accepted |
| [0009](0009-do-not-wait-resume-re-fires-no-short-circuit.md) | `do-not-wait` resume re-fires its branches; no short-circuit | accepted |
| [0010](0010-cost-graph-has-no-consumer.md) | `cost()`'s run-tree graph has no consumer; it stays shallow | accepted |
| [0011](0011-discovery-lists-all-workflows-roots-flagged.md) | Discovery lists all workflows, roots flagged — not roots-only | accepted |
| [0012](0012-operator-config-rejects-env-wrapper.md) | Operator-supplied config rejects `$env`; literal `$secret` still allowed | accepted |
| [0013](0013-client-write-seam-camelcase-in-wire-out.md) | Client write seam is camelCase-in, wire-out — not thin snake-through | accepted |
| [0014](0014-single-node-container-slots-and-sequence-logicer.md) | Single-node container slots, and a `sequence` controller for the array | accepted |
| [0015](0015-designer-node-identity-client-mints-preserve-on-save.md) | Designer node identity: the client mints ids, the server never rewrites them, and a save preserves every id | accepted |
| [0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md) | The workflow write route is a single client-named `PUT` upsert, gated by an ETag precondition | accepted |
| [0017](0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md) | The Designer edit-lock is a server-owned expiring file lease, materialized on disk | accepted |
| [0018](0018-open-node-union-via-pure-registry-factory.md) | The closed node union opens through a pure `makeWorkflowFileSchema(registry)` factory | accepted |
| [0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) | Step plugins are convention-only folders under `packages/engine/plugin/step-plugin/` (the folder moved after ADR 0019), built-ins included | accepted |
| [0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md) | A plugin inherits masking at the emit choke point, and a plugin is engine-level trust | accepted |
| [0021](0021-built-ins-are-the-first-two-plugins-and-the-engine-llm-union-is-gone.md) | The built-ins are the first two plugins, and the `engine \| llm` worker union is gone | accepted |
| [0022](0022-config-vs-field-vs-input-line-for-a-step-type.md) | A step type declares typed `fields` and `config` fragments, and the line between them is operator-invariance | accepted |
| [0023](0023-a-plugin-declares-no-version-and-the-fork-is-the-unit-of-versioning.md) | A step plugin declares no version and no engine-compat; the fork is the unit of versioning | accepted |
| [0024](0024-engine-owns-leaf-step-shaping-a-worker-owns-its-verdict.md) | The engine owns a leaf step's terminal shaping; a worker owns its own verdict | accepted |
| [0025](0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md) | The Designer carries all seven run surfaces, reshaped; shared run-meaning moves into `@path/client-core` | accepted |
| [0026](0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md) | The Designer refuses to open a file with an unregistered step type, rather than opening it read-only or boxing the unknown node | accepted |
| [0027](0027-two-bundles-one-origin-named-mounts-with-root-redirect.md) | Two bundles, one origin: named mounts with a root redirect | accepted |
| [0028](0028-designer-is-a-separate-package-not-a-viewer-route.md) | `@path/designer` is a separate package, not a viewer route | partly superseded by [ADR 0031](0031-designer-reuses-the-viewers-run-panels.md) |
| [0029](0029-designer-canvas-is-the-block-grammar-no-arbitrary-dag.md) | The Designer canvas is the block grammar; no arbitrary DAG | accepted |
| [0030](0030-clean-is-content-equality-to-the-save-point-baseline.md) | "Clean" is content-equality to the save-point baseline; one save-point serves launch, lease, and `If-Match` | accepted |
| [0031](0031-designer-reuses-the-viewers-run-panels.md) | The Designer reuses the Viewer's run panels | accepted |
| [0032](0032-resume-from-k-boundary-representation-and-successor-provenance.md) | Resume-from-K carries the source run id on the wire and persists a derivable descent path on the successor | accepted |
| [0033](0033-designer-resume-from-k-is-a-selection-driven-run-action-button.md) | Designer Resume-from-K is a selection-driven run-action button, always shown, enabled-or-disabled | accepted |
| [0034](0034-resume-eligibility-listing-rides-resume-not-runs-show.md) | The Resume-from-K eligibility listing rides `path run --resume --list-eligible`, not a `path runs show` | accepted |
| [0035](0035-resume-rerun-boundary-is-a-suppression-set-on-the-two-reuse-producers.md) | A Resume rerun boundary is a suppression set on the two reuse producers, not a new walker or a persisted plan | accepted |
| [0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md) | The rerun boundary is a per-level plan-reuse override, so K can descend into a nested workflow | accepted |
| [0037](0037-while-do-iteration-is-a-per-iteration-run-scope.md) | A while-do iteration is a per-iteration run scope, so a loop body reuses across Resume | accepted |
| [0038](0038-awaiting-is-a-leaf-only-status-parents-do-not-propagate.md) | Awaiting is a leaf-only run status; parents do not propagate it | accepted |
| [0039](0039-complete-is-a-durable-engine-re-invocation-over-the-appendable-tree.md) | Complete is a durable engine re-invocation over the appendable tree, not a held process | accepted |
| [0040](0040-output-schema-is-json-schema-validated-with-ajv-from-the-current-file.md) | person-activity outputSchema is JSON Schema, validated with ajv, read from the current file at Complete | accepted |
| [0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md) | Awaiting Complete continues by replaying from the root over the appendable tree | accepted |
| [0042](0042-awaiting-inside-parallel-joins.md) | Awaiting inside a parallel block is a live branch member; the join's existing rules reach it unchanged | accepted |
| [0043](0043-cancel-an-awaiting-tree-is-a-lease-guarded-status-flip.md) | Cancel of an awaiting tree is a lease-guarded status flip, and Resume stays terminal-only | accepted |
| [0044](0044-worker-defaults-a-launch-door-and-a-file-table.md) | Worker-defaults: a launch door and a file table, below an explicit `worker` | accepted |
| [0045](0045-deepseek-credential-config-first-environment-fallback.md) | The `deepseek` worker's credential is config first, environment second | accepted |
| [0046](0046-launch-facts-are-frozen-with-the-run.md) | The operator's launch facts are frozen with the run | accepted |
| [0047](0047-person-switch-is-a-controller-with-an-authored-activity-and-labelled-slots.md) | `person-switch` is a controller holding an authored `person-activity` selection leaf and labelled child slots | superseded by [ADR 0052](0052-person-switch-is-a-shipped-step-template-not-a-controller.md) |
| [0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md) | The Step-Template schema is an envelope over a validated workflow body | accepted |
| [0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md) | Instantiation is a detached copy that re-stamps every id and never rewires | partly superseded by [ADR 0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md) |
| [0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md) | The Template API is id-addressed and owns the template write door | partly superseded by [ADR 0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md) |
| [0051](0051-a-template-is-a-server-authoring-artifact-not-a-step-plugin.md) | A template is a Server authoring artifact, not a step-plugin | accepted |
| [0052](0052-person-switch-is-a-shipped-step-template-not-a-controller.md) | `person-switch` is a shipped step-template, not a controller | accepted |
| [0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) | `goto` is a `SeqOutcome` jump caught by a per-file top-level walk | accepted |
| [0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) | A goto visit is scoped by a per-pass container run | accepted |
| [0055](0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md) | A goto target is seeded by the goto's passed-through output | accepted |
| [0056](0056-a-goto-names-its-target-by-step-name-checked-at-load-in-path-schema.md) | A goto names its target by step name, checked at load in `@path/schema` | accepted |
| [0057](0057-controllers-split-into-structure-and-graph-kinds.md) | Controllers split into Structure and Graph kinds; `goto` narrows the no-DAG stance | accepted |
| [0058](0058-a-goto-is-target-plus-max-jumps-in-path-workflow-5.md) | A goto is `target` + `max_jumps` in `path/workflow@5`, checked by a schema rule module | accepted |
| [0059](0059-context-under-goto-is-one-last-writer-wins-blackboard-across-passes.md) | Context under `goto` is one last-writer-wins blackboard across passes | accepted |
| [0060](0060-complete-follows-the-record-across-closed-passes-and-jump-counts-are-pass-rows.md) | Complete follows the record across closed passes; a goto's jump count is its pass rows | accepted |
| [0061](0061-goto-taken-and-goto-exhausted-are-walk-emitted-control-events.md) | `goto-taken` and `goto-exhausted` are control events the top-level walk emits | accepted |
| [0062](0062-resume-rebuilds-context-by-replay-from-the-seed.md) | Resume rebuilds a re-entered workflow-run's context by replay from its seed | accepted |
| [0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md) | The Workflow-Template is removed; the Step-Template is the only template | accepted |
| [0064](0064-a-sequence-body-is-transparent-to-the-rerun-boundary.md) | A sequence body is transparent to the rerun boundary | accepted |
| [0065](0065-comments-state-what-and-why-decisions-live-in-adrs.md) | Source comments state what and why; decisions live in ADRs | accepted |

## Superseded decisions

- [0028](0028-designer-is-a-separate-package-not-a-viewer-route.md) — partly superseded by [ADR 0031](0031-designer-reuses-the-viewers-run-panels.md): decision 2 (the Designer "does not embed or import the Viewer") is reversed, and the Designer now depends on `@path/viewer` and reuses its run panels. Decision 5 still holds: `@path/designer` stays a separate package with its own bundle and mount.
- [0047](0047-person-switch-is-a-controller-with-an-authored-activity-and-labelled-slots.md) — superseded by [ADR 0052](0052-person-switch-is-a-shipped-step-template-not-a-controller.md): `person-switch` is a shipped step-template composing `person-activity` + `branch`, not a worker-less controller.
- [0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md) — partly superseded by [ADR 0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md): decision 7 (Workflow-Template instantiation into an empty canvas) no longer applies because the Workflow-Template is removed. The Step-Template parts stand.
- [0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md) — partly superseded by [ADR 0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md): the `workflow` template kind, its `workflow-template/` directories and its `*.workflow-template.json` suffix are removed. The Step-Template parts stand.
