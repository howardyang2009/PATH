import { useId, useState, type ReactNode } from "react";
import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";
import { WorkerDefaultsEditor, workerDefaultCandidates } from "@path/viewer";
import {
  CONDITION_ROOTS,
  PUBLISH_ROOTS,
  STEP_ROOTS,
  checkInterpolationSyntax,
  type Condition,
  type ConfigObject,
  type InterpolationRoot,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { ConditionField } from "./condition-builder.js";
import { configRows, dropConfigKey, setConfigKey, type ConfigRow } from "./config-inheritance.js";
import { renderConfigValue } from "./config-value.js";
import { ConfigValueControl } from "./config-value-control.js";
import { editKey, type EditCommit, type EditKey } from "./edit-key.js";
import { replaceNode, withOptionalKey } from "./edit-target.js";
import { editFile, findById, locate, unwrapEdit } from "./edit-tree.js";
import {
  applyNodeConfig,
  configString,
  configStringOf,
  dropNodeKey,
  nodeConfigOf,
  nodePayload,
  nodeString,
  rec,
  setNodeField,
  withConfig,
  withOptionalString,
} from "./node-edit.js";
import { editorTier, pluginFor } from "./editor-tiers.js";
import {
  CheckboxField,
  IdRow,
  NumberField,
  ReadOnlyRow,
  SelectField,
  StringListField,
  TextAreaField,
  TextField,
  fillPlaceholderOnTab,
} from "./pane-controls.js";
import { carriesEnvelope } from "./grammar.js";
import { directionGlyph, gotoTargetOptions } from "./goto-view.js";
import { kindExplanation } from "./node-kind.js";
import { referenceablePaths } from "./interp-suggest.js";
import {
  useKeyedRows,
  useValidatedDraft,
  validateFileInputDraft,
  validateInputDraft,
  validateJsonPayload,
  validateMaxIterations,
  validateOutputSchema,
  type KeyedRow,
  type DraftResult,
} from "./validated-draft.js";

/**
 * The properties pane (#369, designer-spec § Per-kind rendering and edit affordances, § Editors). A
 * single-click on a canvas node populates it; an empty-canvas click (`selectedId` `null`, or a node the
 * active file no longer holds) shows the **file's own** properties. Its layout is fixed top-to-bottom:
 * the node's **role** (only when its container gives one — a branch arm, a branch `else`, a parallel
 * branch), then a one-line **explanation** of the kind, a divider, then the editable fields — `name`
 * first, then `id` (with a confirmation-gated re-key, because a re-key breaks resume plan-reuse, ADR
 * 0015), then the kind-specific fields.
 *
 * The pane's anchor is its **identity** — `name`, then `id` — and it never folds away: it is how the
 * author knows which node is in view. Below it, the kind's own fields are a {@link PaneSection} that
 * opens **expanded**, and the payload regions — a step's **config**, **input**, **context writes** and
 * **reference**, and the file's own **config**, **input**, **worker defaults**, **output** and
 * **reference** — are sections that
 * start **collapsed**: selecting a node shows its identity and its kind fields, and the author unfolds
 * only the payload they came for. A section's header is its toggle, so a collapsed region still names
 * itself. Expansion is per node — a section resets to its default when the selection moves (each is
 * keyed by its owner), so the pane never opens a region the author did not ask for on the node now in
 * view.
 *
 * The step editors are the three tiers (§ Editors): hand-built for `prompt` / `binary` / `workflow`, a
 * generated form for any other registry type, and a live-validated raw-JSON floor for a payload no form
 * can lay out — so every in-registry type always opens. The worker selector is a per-step dropdown shown
 * only when the type ships more than one worker (§ Worker selection); a single-worker type writes no
 * `worker` field.
 */

export interface PropertiesPaneProps {
  file: WorkflowFile;
  /** The selected node's id, or `null` for the file's own properties. */
  selectedId: string | null;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
  /** Re-point the selection after a re-key changes a node's id (ADR 0015). */
  onReselect: (id: string) => void;
  /**
   * Open the ref-target chooser for an empty `workflow` node (#391). Provided only when the active file
   * has a path (a ref is stored relative to the referring file, so it needs one); absent, the ref editor
   * falls back to its plain path field.
   */
  onAddRefTarget?: (nodeId: string) => void;
}

export function PropertiesPane({ file, selectedId, plugins, applyEdit, onReselect, onAddRefTarget }: PropertiesPaneProps): JSX.Element {
  const node = selectedId === null ? null : findById(file.body, selectedId);
  if (node === null) {
    return <FileProperties file={file} plugins={plugins} applyEdit={applyEdit} />;
  }
  return <NodeProperties file={file} node={node} plugins={plugins} applyEdit={applyEdit} onReselect={onReselect} onAddRefTarget={onAddRefTarget} />;
}

/**
 * One collapsible region of the pane: its title is the toggle, and the body mounts only while it is
 * open. The caller decides the default per region — a field section opens expanded (`defaultOpen`),
 * because its fields are what the pane is for, while a payload region starts collapsed. A region that
 * is not open is not in the DOM at all, so its fields cannot be tabbed into or read out of the document
 * order they were left out of.
 */
function PaneSection({
  title,
  className,
  defaultOpen = false,
  children,
}: {
  title: string;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className === undefined ? "pane-section" : `pane-section ${className}`}>
      <button
        type="button"
        className="pane-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="pane-section-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="pane-section-title">{title}</span>
      </button>
      {open ? <div className="pane-section-body">{children}</div> : null}
    </div>
  );
}

// ── The file's own properties ──────────────────────────────────────────────────────────────────────

function FileProperties({
  file,
  plugins,
  applyEdit,
}: {
  file: WorkflowFile;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element {
  return (
    <div className="pane" onKeyDown={fillPlaceholderOnTab}>
      <p className="pane-explain">The workflow file — its identity and the body authored on the canvas.</p>
      <hr className="pane-divider" />
      {/* A keystroke run in one field folds to one undo entry (#389); a different field's identity breaks the run. */}
      <TextField label="name" value={file.name} onChange={(name) => applyEdit({ ...file, name }, editKey(file.id, "name"))} />
      <IdRow id={file.id} onReKey={() => applyEdit({ ...file, id: crypto.randomUUID() })} what="the workflow" />
      <ReadOnlyRow label="format" value={file.format} />
      <hr className="pane-divider" />
      <FileConfigRegion key={`file-config-${file.id}`} file={file} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileInputRegion file={file} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileWorkerDefaultsRegion key={`file-worker-defaults-${file.id}`} file={file} plugins={plugins} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileOutputRegion file={file} applyEdit={applyEdit} />
      <FileReferenceSection file={file} />
    </div>
  );
}

/**
 * The file-level **Reference** list, the counterpart of a node's {@link ReferenceSection} (§ Input/output
 * wiring). The file's only interpolable field is its own `output` map, whose values read `config.` /
 * `context.` (`STEP_ROOTS` — the output map cannot read `output`), so the list gathers exactly those
 * referenceable dot-paths. It is the shared, always-visible reminder that mirrors the per-row `output`
 * autocomplete. `STEP_ROOTS` always contributes its bare prefixes, so the list is never empty and the
 * section always renders.
 */
function FileReferenceSection({ file }: { file: WorkflowFile }): JSX.Element | null {
  return <ReferenceList ownerId={file.id} paths={referenceablePaths(file, [...STEP_ROOTS])} />;
}

/**
 * The **file worker-default** editor (ADR 0044, #505): the shared {@link WorkerDefaultsEditor} bound to
 * the open file's `worker_defaults`. The table is a plain `{ <type>: <name> }` map keyed by type, read
 * and written by constrained dropdowns, so an invalid `{ type, worker }` pair — the hard load error ADR
 * 0044 defines — cannot be authored in the pane. An empty map drops the whole key (as an empty
 * `config`/`output` does), so `worker_defaults: {}` never lands.
 *
 * The **launch** tier has no editor here: it is supplied at launch, not authored in a file, and the
 * Viewer's launch form owns it (ADR 0044).
 *
 * A registry whose types all ship a single worker offers nothing to select, so the whole section — the
 * collapsible header included — is not rendered.
 */
function FileWorkerDefaultsRegion({
  file,
  plugins,
  applyEdit,
}: {
  file: WorkflowFile;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element | null {
  // No multi-worker type in the registry → no selection to make. Hide the section entirely.
  if (workerDefaultCandidates(plugins).length === 0) return null;

  const write = (map: { [type: string]: string }): void => {
    // An empty table omits the key rather than writing `worker_defaults: {}` (`withOptionalKey`).
    applyEdit(withOptionalKey(file, "worker_defaults", Object.keys(map).length === 0 ? undefined : map));
  };

  return (
    <PaneSection title="worker defaults">
      <WorkerDefaultsEditor
        plugins={plugins}
        value={file.worker_defaults ?? {}}
        onChange={write}
        hint="The worker each type's un-pinned steps use in this file. A per-type selection, not config: a step's own worker still wins, and this never crosses a workflow reference."
      />
    </PaneSection>
  );
}

/** A `key → value` map (a file's `output`, a step's `publish`) read back as editor rows, each value in its string form. */
function keyedRowsOf(map: unknown): KeyedRow[] {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/**
 * The workflow's own **output** object (workflow-format-v0.md §6.4): a `key → ${…}` map evaluated at
 * success into the value a parent's `publish` reads back across a `workflow`-ref (§ Input/output wiring).
 * Each value is an interpolable string over `config.`/`context.` (`STEP_ROOTS` — the output map cannot read
 * `output`). Held as a draft and committed only when every value's interpolation is valid, so an ill-typed
 * `${…}` never reaches the file; clearing the last row drops the whole `output` key. Structured (non-string)
 * output values are shown JSON-stringified and re-saved as strings — a flat string contract is what this
 * editor authors.
 */
function FileOutputRegion({ file, applyEdit }: { file: WorkflowFile; applyEdit: EditCommit<WorkflowFile> }): JSX.Element {
  // The file's `output` map is a keyed-row field (`useKeyedRows`): an empty map drops the whole `output`
  // key, so an empty `output: {}` never lands. A row edit folds to one undo entry (#389, `file-output:…`).
  const { rows, setRow, addRow, removeRow } = useKeyedRows(
    () => keyedRowsOf((file as { output?: unknown }).output),
    STEP_ROOTS,
    editKey(file.id, "output"),
    (map, key) => {
      // An empty map omits the `output` key rather than writing `output: {}` (`withOptionalKey`).
      applyEdit(withOptionalKey(file, "output", Object.keys(map).length === 0 ? undefined : map), key);
    },
  );

  return (
    <PaneSection title="output">
      <p className="pane-hint">The workflow's output object, evaluated at success — what a parent's publish reads back from a workflow reference.</p>
      {rows.length > 0 ? (
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <KeyedRowField
              key={index}
              row={row}
              roots={STEP_ROOTS}
              keyLabel="Output key"
              valueLabel="Output value"
              removeLabel="Remove output"
              keyPlaceholder="output key"
              // The value placeholder mirrors the key the author typed — `${context.<key>}` — the most
              // common output: land the step context value of the same name. Falls back before a key is typed.
              valuePlaceholder={(r) => `\${context.${r.key === "" ? "key" : r.key}}`}
              onChange={(r) => setRow(index, r)}
              onRemove={() => removeRow(index)}
            />
          ))}
        </div>
      ) : null}
      <button type="button" className="pane-btn" onClick={addRow}>
        + add output key
      </button>
    </PaneSection>
  );
}

// ── A selected node's properties ─────────────────────────────────────────────────────────────────

function NodeProperties({
  file,
  node,
  plugins,
  applyEdit,
  onReselect,
  onAddRefTarget,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
  onReselect: (id: string) => void;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  // A field edit passes its identity so a run of keystrokes folds to one undo entry (#389); a discrete
  // change (a select, a re-key) passes none, so it is its own entry. The splice itself is
  // `replaceNode`'s (`edit-target.ts`), the one node write door.
  const commit = (next: WorkflowNode, key?: EditKey): void => applyEdit(replaceNode(file, next), key);
  const reKey = (): void => {
    const id = crypto.randomUUID();
    // The one edit found by its *previous* id: the re-key replaces the node that holds `node.id` today.
    applyEdit(replaceNode(file, { ...node, id }, node.id));
    onReselect(id);
  };
  const site = locate(file, node.id);
  const role = occupantRole(site, file);
  const condSuggest = referenceablePaths(file, CONDITION_ROOTS);

  return (
    <div className="pane" onKeyDown={fillPlaceholderOnTab}>
      {role ? (
        <p className="pane-role" role="note">
          {role}
        </p>
      ) : null}
      <p className="pane-explain">{kindExplanation(node.type)}</p>
      <hr className="pane-divider" />
      {/* Identity is the pane's anchor — which node is this — so `name` and `id` never fold away. The
          kind's own fields are a section: they open expanded, and folding them is an option for a busy
          node, never a step before an ordinary edit. */}
      <TextField label="name" value={node.name} onChange={(name) => commit({ ...node, name }, editKey(node.id, "name"))} />
      <IdRow id={node.id} onReKey={reKey} what={`"${node.name}"`} />
      <PaneSection key={`fields-${node.id}`} title={node.type} className="pane-fields" defaultOpen>
        {site?.where === "arm" ? (
          <ConditionField
            label="when"
            condition={armWhen(file, site.ownerId, site.armIndex)}
            suggestions={condSuggest}
            identity={editKey(node.id, "when")}
            onChange={(when) =>
              applyEdit(unwrapEdit(editFile(file, { kind: "set-arm-when", branchId: site.ownerId, armIndex: site.armIndex, when })))
            }
          />
        ) : null}
        <KindFields file={file} node={node} plugins={plugins} commit={commit} condSuggest={condSuggest} onAddRefTarget={onAddRefTarget} />
      </PaneSection>
      {carriesEnvelope(node.type) ? <StepEnvelopeFields file={file} node={node} commit={commit} /> : null}
      <ReferenceSection file={file} node={node} site={site} />
    </div>
  );
}

/**
 * The one **Reference** list, rendered at the very end of the pane (§ Input/output wiring). It gathers
 * the dot-paths this node's interpolable fields may read — so an author sees the referenceable paths in
 * one place, not repeated under each field. The roots are the union of what the node's own fields allow:
 * a leaf step reads the input/publish roots, a `while-do` its condition and count roots, a `checkpoint`
 * its condition roots, and any arm occupant adds its `when` roots. A node with no interpolable field
 * (`parallel`, `sequence`, a bare `branch`) contributes no roots, so the section does not render. Each
 * field still validates against its own roots and keeps its own path autocomplete; this list is the
 * shared, always-visible reminder.
 */
function ReferenceSection({ file, node, site }: { file: WorkflowFile; node: WorkflowNode; site: ReturnType<typeof locate> }): JSX.Element | null {
  const roots = new Set<InterpolationRoot>();
  if (site?.where === "arm") for (const root of CONDITION_ROOTS) roots.add(root);
  if (node.type === "while-do") {
    for (const root of CONDITION_ROOTS) roots.add(root);
    for (const root of STEP_ROOTS) roots.add(root);
  } else if (node.type === "checkpoint") {
    for (const root of CONDITION_ROOTS) roots.add(root);
  } else if (carriesEnvelope(node.type)) {
    for (const root of PUBLISH_ROOTS) roots.add(root);
  }
  if (roots.size === 0) return null;
  return <ReferenceList ownerId={node.id} paths={referenceablePaths(file, [...roots])} />;
}

/** The "reference" section's body: the referenceable dot-paths, or nothing when there are none. */
function ReferenceList({ ownerId, paths }: { ownerId: string; paths: readonly string[] }): JSX.Element | null {
  if (paths.length === 0) return null;
  return (
    <>
      <hr className="pane-divider" />
      {/* Keyed by the owner: a new selection opens the section collapsed again. */}
      <PaneSection key={ownerId} title="reference" className="pane-reference">
        <p className="pane-hint pane-suggest">{paths.join(" · ")}</p>
      </PaneSection>
    </>
  );
}

/** The `when` condition of a branch arm, read back off the parent branch for the pane's builder. */
function armWhen(file: WorkflowFile, branchId: string, armIndex: number): Condition {
  const owner = findById(file.body, branchId);
  const when = owner?.type === "branch" ? owner.arms[armIndex]?.when : undefined;
  return when ?? { type: "exists", path: "context.value" };
}

/**
 * The role a node's container gives it (§ Pane layout, orientation before editing). Only a container
 * that distinguishes its occupants supplies one: a branch arm (its 1-based position among the arms), a
 * branch `else`, or a parallel branch. A file-body node, a `sequence` element, and a `while-do` body
 * carry no role — their position says nothing the block render does not already.
 */
function occupantRole(site: ReturnType<typeof locate>, file: WorkflowFile): string | null {
  if (!site) return null;
  if (site.where === "else") return "branch else fallback";
  if (site.where === "list" && site.listKind === "branches") return "parallel branch";
  if (site.where === "arm") {
    const owner = findById(file.body, site.ownerId);
    const total = owner?.type === "branch" ? owner.arms.length : 0;
    return `branch arm (${site.armIndex + 1} of ${total})`;
  }
  return null;
}

// ── The kind-specific field region ───────────────────────────────────────────────────────────────

function KindFields({
  file,
  node,
  plugins,
  commit,
  condSuggest,
  onAddRefTarget,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: EditCommit<WorkflowNode>;
  condSuggest: string[];
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  // `person-activity` is a plugin leaf outside the core node union (its fields ride loosely, like
  // `awaiting-node.ts` reads them), so it is dispatched here by its string type before the union switch.
  if ((node.type as string) === "person-activity") {
    return <PersonActivityEditor node={node} commit={commit} />;
  }
  switch (node.type) {
    case "prompt":
      return <PromptEditor file={file} node={node} plugins={plugins} commit={commit} />;
    case "workflow":
      return <WorkflowRefEditor node={node} commit={commit} onAddRefTarget={onAddRefTarget} />;
    case "parallel":
      return (
        <SelectField
          label="join"
          value={node.join}
          options={["collect", "wait-one", "do-not-wait"]}
          onChange={(join) => commit({ ...node, join: join as typeof node.join })}
        />
      );
    case "while-do":
      return (
        <>
          <ConditionField
            label="condition"
            condition={node.condition}
            suggestions={condSuggest}
            identity={editKey(node.id, "condition")}
            onChange={(condition) => commit({ ...node, condition })}
          />
          <MaxIterationsField
            identity={editKey(node.id, "max_iterations")}
            value={node.max_iterations}
            onChange={(v) => commit({ ...node, max_iterations: v }, editKey(node.id, "max_iterations"))}
          />
        </>
      );
    case "goto":
      return <GotoEditor file={file} node={node} commit={commit} />;
    case "branch":
      return <p className="pane-hint">Arms and else are edited on the canvas; a Branch has no fields of its own.</p>;
    case "sequence":
      return <p className="pane-hint">Order is structure — reorder the body on the canvas.</p>;
    case "checkpoint":
      return (
        <ConditionField
          label="condition"
          condition={node.condition}
          suggestions={condSuggest}
          identity={editKey(node.id, "condition")}
          onChange={(condition) => commit({ ...node, condition })}
        />
      );
    default:
      return <LeafPayloadEditor file={file} node={node} plugins={plugins} commit={commit} />;
  }
}

/**
 * `goto` — the `target` picker and the mandatory `max_jumps` (#619, designer-spec § goto). The picker
 * lists every first-level node in file order, the goto itself excluded, each marked `↑` backward or `↓`
 * forward. A value naming no eligible node (the minted `""`, a deleted or moved target) stays selected as
 * `missing: <name>` and is never cleared silently. `max_jumps` shares `max_iterations`' grammar.
 */
function GotoEditor({ file, node, commit }: { file: WorkflowFile; node: Extract<WorkflowNode, { type: "goto" }>; commit: EditCommit<WorkflowNode> }): JSX.Element {
  const options = gotoTargetOptions(file, node.id);
  const eligible = options.some((option) => option.name === node.target);
  const glyphs = new Map(options.map((option) => [option.name, directionGlyph(option.direction)]));
  return (
    <>
      <SelectField
        label="target"
        value={node.target}
        options={eligible ? options.map((option) => option.name) : [node.target, ...options.map((option) => option.name)]}
        optionLabel={(name) => (glyphs.has(name) ? `${glyphs.get(name)} ${name}` : `missing: ${name === "" ? '""' : name}`)}
        onChange={(target) => commit({ ...node, target })}
      />
      <MaxIterationsField
        label="max jumps"
        identity={editKey(node.id, "max_jumps")}
        value={node.max_jumps}
        onChange={(v) => commit({ ...node, max_jumps: v }, editKey(node.id, "max_jumps"))}
      />
    </>
  );
}

/** `prompt` — the first-class editor: the `model` (a config datum) and the `prompt` text, plus the worker. */
function PromptEditor({ file, node, plugins, commit }: LeafEditorProps): JSX.Element {
  const prompt = nodeString(node, "prompt");
  const inheritedModel = configStringOf(file.config, "model");
  return (
    <>
      <ModelField
        value={configString(node, "model")}
        inherited={inheritedModel}
        onChange={(v) => commit(withConfig(node, "model", v), editKey(node.id, "config", "model"))}
      />
      <TextAreaField label="prompt" value={prompt} onChange={(v) => commit({ ...node, prompt: v } as WorkflowNode, editKey(node.id, "prompt"))} />
      <WorkerSelect file={file} node={node} plugins={plugins} commit={commit} />
    </>
  );
}

/**
 * The prompt editor's `model` line (#369). Its `model` is a config datum, so it inherits from the
 * workflow's `config.model` like any other key — but as a first-class field it edits as an input, not a
 * ghosted config row. When the node holds no own `model`, the input stays empty and shows the inherited
 * value as a ghosted placeholder: leaving it blank keeps inheriting, and typing overrides. With no own
 * and no inherited value the placeholder is a plain prompt. When the node overrides an inherited value,
 * a **Revert** drops the local `model` and restores the inherited one — the config-row Revert, but for
 * this first-class field.
 */
function ModelField({ value, inherited, onChange }: { value: string; inherited: string; onChange: (v: string) => void }): JSX.Element {
  const inheriting = value === "" && inherited !== "";
  const overridden = value !== "" && inherited !== "";
  // The input keeps a fixed position in the tree — its wrapper renders in every state, and only the
  // Revert button toggles inside it — so appearing Revert never re-parents (and so re-mounts, dropping
  // focus) the input the author is typing into. Input and Revert share one line: the input flexes, the
  // button stays inline (no wrap).
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">model</span>
      <div className="pane-model-value">
        <input
          className={inheriting ? "pane-input pane-input-inherit" : "pane-input"}
          type="text"
          value={value}
          placeholder={inherited !== "" ? inherited : "model id"}
          onChange={(e) => onChange(e.target.value)}
          title={inheriting ? `Inherited from the workflow config: ${inherited}` : undefined}
        />
        {overridden ? (
          <button type="button" className="pane-btn" onClick={() => onChange("")} title={`Revert to the inherited model: ${inherited}`}>
            Revert
          </button>
        ) : null}
      </div>
    </label>
  );
}

/** `workflow`-ref — the first-class editor: the referenced file path. A workflow step carries no worker. */
function WorkflowRefEditor({
  node,
  commit,
  onAddRefTarget,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  const ref = nodeString(node, "ref");
  // An empty ref on a file with a path offers the target chooser (#391): reference an existing workflow,
  // or create a new one and descend into it. Without a path (a from-scratch root) or once a ref is set,
  // the plain path field is the editor — a set ref stays retargetable by hand.
  if (ref === "" && onAddRefTarget) {
    return (
      <div className="pane-field ref-target-field">
        <span className="pane-label">referenced file</span>
        <p className="pane-hint">This reference has no target yet.</p>
        <button type="button" className="ref-choose-target" onClick={() => onAddRefTarget(node.id)}>
          Choose a reference target…
        </button>
      </div>
    );
  }
  return <TextField label="referenced file" value={ref} onChange={(v) => commit({ ...node, ref: v } as WorkflowNode, editKey(node.id, "ref"))} />;
}

/**
 * `person-activity` — the first-class editor (#487, #470): the three type fields a Complete surface reads
 * from the file by node id (CONTEXT.md § Person-activity). `description` is the interpolable (`{{…}}`)
 * instructions shown to the person, authored as plain text — the server resolves the placeholders at
 * Complete time, so the pane neither resolves nor validates them. `outputSchema` is the JSON-Schema object
 * the Complete form is built from (re-read and validated at Complete, ADR 0040): a live-validated JSON box
 * that commits only a valid object and drops the key when cleared. `assignee` is the optional
 * informational label (no enforcement). The step's own worker is fixed (`person`), so no worker selector shows.
 */
function PersonActivityEditor({ node, commit }: { node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  const description = nodeString(node, "description");
  const assignee = nodeString(node, "assignee");
  return (
    <>
      <TextAreaField
        label="description"
        value={description}
        onChange={(v) => commit(setNodeField(node, "description", v), editKey(node.id, "description"))}
      />
      <OutputSchemaField node={node} commit={commit} />
      <TextField label="assignee" value={assignee} onChange={(v) => commit(withOptionalString(node, "assignee", v), editKey(node.id, "assignee"))} />
    </>
  );
}

/**
 * `person-activity`'s **outputSchema** — a live-validated JSON textarea (`validateOutputSchema`): a valid
 * JSON object commits, an empty box drops the key (the server then accepts any output), and an
 * unparseable or non-object draft is shown with its error but never committed, so the node stays
 * strict-valid. Seeded from the node's current schema, pretty-printed.
 */
function OutputSchemaField({ node, commit }: { node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  return (
    <JsonDraftField
      id={`output-schema-${node.id}`}
      label="outputSchema (JSON Schema, optional)"
      rows={8}
      initial={() => {
        const schema = rec(node).outputSchema;
        return schema === undefined ? "" : JSON.stringify(schema, null, 2);
      }}
      validate={(text) => validateOutputSchema(node, text)}
      identity={editKey(node.id, "outputSchema")}
      commit={commit}
    />
  );
}

/**
 * A generic registry leaf: the generated form when every field lays out, else the raw-JSON floor. Both
 * carry the worker selector. `editorTier` has already decided which tier this type takes; this switch
 * just renders it.
 */
function LeafPayloadEditor({ file, node, plugins, commit }: LeafEditorProps): JSX.Element {
  const tier = editorTier(node.type, plugins);
  const plugin = pluginFor(node.type, plugins);
  return (
    <>
      {tier === "generic" && plugin ? (
        <GenericForm node={node} fields={plugin.fields} commit={commit} />
      ) : (
        <RawJsonFloor node={node} plugins={plugins} commit={commit} />
      )}
      <WorkerSelect file={file} node={node} plugins={plugins} commit={commit} />
    </>
  );
}

/** The generic tier — one typed control per field of the type's `fields` fragment (§ Editors, generic row). */
function GenericForm({
  node,
  fields,
  commit,
}: {
  node: WorkflowNode;
  fields: Record<string, WireFieldSpec>;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
  const record = rec(node);
  return (
    <>
      {Object.entries(fields).map(([name, spec]) => (
        <GenericField key={name} name={name} spec={spec} value={record[name]} onChange={(v) => commit(setNodeField(node, name, v), editKey(node.id, name))} />
      ))}
    </>
  );
}

function GenericField({
  name,
  spec,
  value,
  onChange,
}: {
  name: string;
  spec: WireFieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}): JSX.Element {
  // The field label is the payload key verbatim (small first character, matching the JSON key).
  const label = name;
  if (spec.type === "boolean") {
    return <CheckboxField label={label} value={value === true} onChange={onChange} />;
  }
  if (spec.type === "number") {
    return <NumberField label={label} value={typeof value === "number" ? value : null} onChange={(n) => onChange(n ?? undefined)} />;
  }
  if (spec.type === "array") {
    const list = Array.isArray(value) ? value.map(String) : [];
    return <StringListField label={label} values={list} onChange={(l) => onChange(l.length ? l : undefined)} />;
  }
  return <TextField label={label} value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v === "" ? undefined : v)} />;
}

/**
 * The raw-JSON floor (§ Editors, last row): one live-validated textarea for the node's payload — every
 * field outside the identity/control envelope. On each edit it parses the JSON, rebuilds the node from
 * the envelope plus the parsed payload, and validates the whole file against the registry
 * (`safeParseWorkflowFile`); an invalid draft shows the error and is **not** committed, so the node on
 * the canvas stays strict-valid and only the editor's fidelity degrades.
 */
function RawJsonFloor({ node, plugins, commit }: Omit<LeafEditorProps, "file">): JSX.Element {
  return (
    <JsonDraftField
      id={`raw-json-${node.id}`}
      label="payload (JSON)"
      rows={8}
      initial={() => JSON.stringify(nodePayload(node), null, 2)}
      validate={(text) => validateJsonPayload(node, text, plugins)}
      identity={editKey(node.id, "payload")}
      commit={commit}
    />
  );
}

/**
 * The worker dropdown — shown only when the type ships more than one worker (§ Worker selection).
 *
 * An un-pinned step (no `worker` field) no longer means "the type's default": with a **file
 * worker-default** it resolves to the file's pick for the type instead (ADR 0044, four-tier resolution
 * `node.worker → launch → file → type`). So the dropdown carries an explicit leading `(default)` option
 * whose value is empty: choosing it drops `worker` (stays un-pinned), and its label names the *effective*
 * resolution and the tier it came from — `(default: <worker> — file)` when the file table pins the type,
 * else `(default: <worker> — type)`. Picking a concrete worker pins `node.worker` — a deliberate author
 * pin, the only thing above a launch/file default. The launch default is operator-launch-time, in no
 * file, so it is never shown here (#505). This mirrors the `config.model` inherit ghost (`ModelField`).
 */
function WorkerSelect({ file, node, plugins, commit }: LeafEditorProps): JSX.Element | null {
  const plugin = pluginFor(node.type, plugins);
  if (!plugin || plugin.workers.length <= 1) return null;
  const pinned = nodeString(node, "worker");
  const fileDefault = file.worker_defaults?.[node.type];
  // What an un-pinned step resolves to *in the Designer's view*: the file default if the file pins this
  // type, else the type's own default. The launch tier is invisible here, so it is not part of this.
  const effective = fileDefault ?? plugin.default_worker;
  const effectiveTier = fileDefault !== undefined ? "file" : "type";
  // Empty value is the "(default)" option — the un-pinned case, distinct from any real worker name.
  const UNPINNED = "";
  const onChange = (worker: string): void => {
    if (worker === UNPINNED) commit(dropNodeKey(node, "worker"));
    else commit(setNodeField(node, "worker", worker));
  };
  return (
    <SelectField
      label="worker"
      value={pinned || UNPINNED}
      options={[UNPINNED, ...plugin.workers]}
      optionLabel={(w) => (w === UNPINNED ? `(default: ${effective} — ${effectiveTier})` : w)}
      onChange={onChange}
    />
  );
}

// ── The step envelope: config inheritance, input wiring, and context writes (#370) ─────────────────

/** Config keys a first-class editor already owns, so the inheritance region does not double them (`model`, #369). */
function firstClassConfigKeys(type: string): ReadonlySet<string> {
  return type === "prompt" ? new Set(["model"]) : new Set();
}

/**
 * The shared envelope every leaf step carries (§ Config inheritance display, § Input/output wiring,
 * § Context reads and writes): the inheritance-aware **config** region, the interpolable **input** object,
 * and the **publish** / **parse** context-write fields. Control blocks carry none of these, so this renders
 * only for a step-carrying node (`carriesEnvelope`).
 */
function StepEnvelopeFields({ file, node, commit }: { file: WorkflowFile; node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  return (
    <>
      <hr className="pane-divider" />
      <ConfigRegion key={`config-${node.id}`} file={file} node={node} commit={commit} />
      <InputEditor node={node} commit={commit} />
      <PublishParseFields node={node} commit={commit} />
    </>
  );
}

/**
 * The config-inheritance region (§ Config inheritance display): an inherited key ghosted read-only with
 * its origin and an **Override**; an overridden key solid with a **revert-to-inherited**; a local key
 * solid. The `type` field never appears here — it edits in the kind-fields region and does not inherit.
 */
function ConfigRegion({ file, node, commit }: { file: WorkflowFile; node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  const config = nodeConfigOf(node);
  // A value edit passes its identity so a keystroke run in one config value folds to one undo entry
  // (#389); a discrete write (Override/Revert/×/add-key) passes none, so it is its own entry.
  const write = (next: ConfigObject | undefined, key?: EditKey): void => commit(applyNodeConfig(node, next), key);
  return (
    <ConfigEditor
      parentConfig={file.config}
      config={config}
      hide={firstClassConfigKeys(node.type)}
      scopeId={node.id}
      write={write}
      emptyHint="No config. Add a key, or inherit one from the workflow."
    />
  );
}

/**
 * The shared config editor behind both the step region (`ConfigRegion`, inheritance-aware) and the
 * file's own config (`FileConfigRegion`, no parent so every key is local). `parentConfig` is the
 * inheritance source — the enclosing workflow's config for a step, `undefined` for the file itself,
 * whose config *is* the root every step inherits from. `scopeId` scopes each value's identity so two
 * owners' same-named keys never fold their undo runs together (#389).
 */
function ConfigEditor({
  parentConfig,
  config,
  hide,
  scopeId,
  write,
  emptyHint,
}: {
  parentConfig: ConfigObject | undefined;
  config: ConfigObject | undefined;
  hide?: ReadonlySet<string>;
  scopeId: string;
  write: EditCommit<ConfigObject | undefined>;
  emptyHint: string;
}): JSX.Element {
  const [newKey, setNewKey] = useState("");
  const rows = configRows(parentConfig, config, hide);
  const addKey = (): void => {
    const key = newKey.trim();
    if (key === "") return;
    write(setConfigKey(config, key, ""));
    setNewKey("");
  };
  return (
    <PaneSection key={scopeId} title="config">
      {rows.length === 0 ? <p className="pane-hint">{emptyHint}</p> : null}
      {rows.length > 0 ? (
        // One shared grid so every row's `=` sits in the same column, aligned down the list.
        <div className="pane-config-grid">
          {rows.map((row) => (
            <ConfigRowField key={row.key} row={row} config={config} nodeId={scopeId} write={write} />
          ))}
        </div>
      ) : null}
      <div className="pane-field pane-field-inline pane-config-add">
        <input
          className="pane-input"
          type="text"
          aria-label="New config key"
          placeholder="new key"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button type="button" className="pane-btn" onClick={addKey} disabled={newKey.trim() === ""}>
          + add config key
        </button>
      </div>
    </PaneSection>
  );
}

/**
 * The file's own **config** (§ Config inheritance display): the workflow-level defaults every step
 * inherits. Unlike a step's region there is no parent to inherit from — the file's config *is* the root
 * — so every key renders local (add / edit as literal · `$env` · `$secret` / remove). A cleared config
 * drops the whole `config` field, so an empty `config: {}` never lands in the file.
 */
function FileConfigRegion({ file, applyEdit }: { file: WorkflowFile; applyEdit: EditCommit<WorkflowFile> }): JSX.Element {
  const write = (next: ConfigObject | undefined, key?: EditKey): void => {
    // A cleared config omits the field rather than writing `config: {}` (`withOptionalKey`).
    applyEdit(withOptionalKey(file, "config", next), key);
  };
  return (
    <ConfigEditor
      parentConfig={undefined}
      config={file.config}
      scopeId="file"
      write={write}
      emptyHint="No config. Add a key to set a workflow default that every step inherits."
    />
  );
}

/**
 * The file's own **input** seed: the workflow's default root context seed, sent at launch when the
 * operator supplies no override (the Viewer's `Override input (optional)` field). A live-validated JSON
 * textarea, like a step's `input` but with no interpolation — nothing resolves the root seed before it
 * seeds context, so only plain JSON is accepted. An empty box or `{}` drops the whole `input` key, so
 * an empty `input: {}` never lands. A blank box reads back as `{}`, the field's own empty default.
 */
function FileInputRegion({ file, applyEdit }: { file: WorkflowFile; applyEdit: EditCommit<WorkflowFile> }): JSX.Element {
  const identity = editKey(file.id, "input");
  return (
    <PaneSection title="input">
      <JsonDraftField
        id={`file-input-${file.id}`}
        label="input (JSON object, the workflow's launch seed)"
        rows={5}
        initial={() => (file.input === undefined ? "{}" : JSON.stringify(file.input, null, 2))}
        validate={(text) => validateFileInputDraft(file, text)}
        identity={identity}
        commit={(next) => applyEdit(next, identity)}
      />
    </PaneSection>
  );
}

/** One config row, rendered by origin: inherited (ghosted + Override), overridden (revert), or local. */
function ConfigRowField({
  row,
  config,
  nodeId,
  write,
}: {
  row: ConfigRow;
  config: ConfigObject | undefined;
  /** The owning node's id — scopes the value's identity so two nodes' same-named keys never fold (#389). */
  nodeId: string;
  write: EditCommit<ConfigObject | undefined>;
}): JSX.Element {
  if (row.origin === "inherited") {
    return (
      <div className="pane-field pane-config-row" data-origin="inherited">
        <span className="pane-label">{row.key}</span>
        <span className="pane-config-eq" aria-hidden="true">=</span>
        <div className="pane-config-inherited">
          <code className="pane-config-value pane-ghost">{renderConfigValue(row.value)}</code>
          <button type="button" className="pane-btn" onClick={() => write(setConfigKey(config, row.key, row.value))}>
            Override
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-field pane-config-row" data-origin={row.origin}>
      <span className="pane-label">{row.key}</span>
      <span className="pane-config-eq" aria-hidden="true">=</span>
      <div className="pane-config-local">
        <ConfigValueControl value={row.value} onChange={(v) => write(setConfigKey(config, row.key, v), editKey(nodeId, "config", row.key))} label={row.key} />
        {row.origin === "overridden" ? (
          <button type="button" className="pane-btn" onClick={() => write(dropConfigKey(config, row.key))}>
            Revert
          </button>
        ) : (
          <button type="button" className="pane-btn" aria-label={`Remove ${row.key}`} onClick={() => write(dropConfigKey(config, row.key))}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The interpolable **input** object (§ Input/output wiring): one live-validated JSON textarea whose
 * `${…}` placeholders reference `config.` / `context.` dot-paths — the roots the schema allows a step to
 * read *before it runs* (`STEP_ROOTS`; a step's own `output` does not exist yet). It validates against
 * exactly those roots, so the pane accepts only what a load-time parse would; an unclosed or ill-typed
 * placeholder is reported and never committed, and the referenceable paths are offered as autocomplete.
 */
function InputEditor({ node, commit }: { node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  return (
    <PaneSection key={node.id} title="input">
      <JsonDraftField
        id={`input-${node.id}`}
        label="input (any JSON value, ${…} interpolable)"
        rows={5}
        initial={() => {
          const input = rec(node).input;
          return input === undefined ? "{}" : JSON.stringify(input, null, 2);
        }}
        validate={(text) => validateInputDraft(node, text)}
        identity={editKey(node.id, "input")}
        commit={commit}
      />
    </PaneSection>
  );
}

/**
 * The context-**write** fields (§ Context reads and writes): `publish` (a `key → ${…}` map, each value an
 * interpolable string over `config.`/`context.`/`output.`) and `parse`. These are pane fields on the step,
 * never canvas edges. A publish conflict the load-time checks reject surfaces separately, as a node
 * validation marker on the canvas (the publish-set rule in `@path/schema`, projected by `problems.ts`).
 */
function PublishParseFields({ node, commit }: { node: WorkflowNode; commit: EditCommit<WorkflowNode> }): JSX.Element {
  const parse = nodeString(node, "parse");

  // The node's `publish` map is a keyed-row field (`useKeyedRows`): it commits only when every value's
  // interpolation is valid, so an ill-typed `${…}` publish never reaches the file and the node stays
  // strict-valid (§ Context reads and writes). An empty map drops the `publish` key; a row edit folds to
  // one undo entry (#389, the field's identity plus the row — scoped by node, so two nodes' rows never
  // fold together).
  const { rows, setRow, addRow, removeRow } = useKeyedRows(
    () => keyedRowsOf(rec(node).publish),
    PUBLISH_ROOTS,
    editKey(node.id, "publish"),
    (map, key) =>
      commit(Object.keys(map).length === 0 ? dropNodeKey(node, "publish") : ({ ...node, publish: map } as WorkflowNode), key),
  );

  return (
    <PaneSection key={node.id} title="context writes">
      {rows.length > 0 ? (
        // One shared grid so every row's `=` sits in the same column, aligned down the list (§ Config).
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <KeyedRowField
              key={index}
              row={row}
              roots={PUBLISH_ROOTS}
              keyLabel="Publish key"
              valueLabel="Publish value"
              removeLabel="Remove publish"
              keyPlaceholder="context key"
              valuePlaceholder={() => "${output.x}"}
              onChange={(r) => setRow(index, r)}
              onRemove={() => removeRow(index)}
            />
          ))}
        </div>
      ) : null}
      <button type="button" className="pane-btn" onClick={addRow}>
        + add publish
      </button>
      <SelectField
        label="parse"
        value={parse === "" ? "(none)" : parse}
        options={["(none)", "text", "json"]}
        onChange={(v) => commit(v === "(none)" ? dropNodeKey(node, "parse") : (setNodeField(node, "parse", v)))}
      />
    </PaneSection>
  );
}

/**
 * One keyed-row line — `key = value ×` — behind both the node's `publish` map and the file's `output`
 * map. The value is live-checked against the field's own `roots`; the row is transparent to the grid
 * (`display: contents`) so its key, `=`, and value cell share the section grid and the `=` lines up down
 * the list (§ Config). Labels, the key placeholder, and the value placeholder come from the owner, since
 * the two fields differ only there.
 */
function KeyedRowField({
  row,
  roots,
  keyLabel,
  valueLabel,
  removeLabel,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
  onRemove,
}: {
  row: KeyedRow;
  roots: readonly InterpolationRoot[];
  keyLabel: string;
  valueLabel: string;
  removeLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: (row: KeyedRow) => string;
  onChange: (row: KeyedRow) => void;
  onRemove: () => void;
}): JSX.Element {
  const check = checkInterpolationSyntax(row.value, roots);
  return (
    <div className="pane-publish-row">
      <input className="pane-input" type="text" aria-label={keyLabel} placeholder={keyPlaceholder} value={row.key} onChange={(e) => onChange({ ...row, key: e.target.value })} />
      <span className="pane-publish-eq" aria-hidden="true">=</span>
      <div className="pane-publish-value">
        <input className="pane-input" type="text" aria-label={valueLabel} placeholder={valuePlaceholder(row)} value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} aria-invalid={!check.ok} />
        <button type="button" className="pane-btn" aria-label={removeLabel} onClick={onRemove}>
          ×
        </button>
      </div>
      {!check.ok ? (
        <p className="pane-error" role="alert">
          {check.error}
        </p>
      ) : null}
    </div>
  );
}

// ── The max-iterations field (schema-validated, so it stays with the pane) ─────────────────────────

/**
 * `while-do`'s **max iterations**. The schema takes either a positive whole number or a `${config.…}` /
 * `${context.…}` interpolation over the step roots (`MaxIterationsSchema`, `STEP_ROOTS`), so the pane
 * cannot be a number-only input — a number-only field can never point the cap at a workflow config datum
 * like `${config.max_revisions}`. It is a text field held as a draft: a run of digits commits as a
 * number, an interpolation commits as a string once its `${…}` syntax checks out, and anything else is
 * flagged and not committed — so the node on the canvas stays strict-valid.
 */
function MaxIterationsField({
  label = "max iterations",
  identity,
  value,
  onChange,
}: {
  label?: string;
  identity: EditKey;
  value: number | string;
  onChange: (v: number | string) => void;
}): JSX.Element {
  const id = useId();
  const { draft, error, onEdit } = useValidatedDraft(() => String(value), validateMaxIterations, identity, onChange);

  return (
    <div className="pane-field pane-field-row">
      <label className="pane-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pane-input"
        type="text"
        value={draft}
        placeholder="10 or ${config.max_revisions}"
        onChange={(e) => onEdit(e.target.value)}
        aria-invalid={error !== null}
      />
      <FieldError error={error} />
    </div>
  );
}

// ── Shared field pieces ───────────────────────────────────────────────────────────────────────────

/**
 * A live-validated JSON textarea: every keystroke is validated, only a valid value commits, and an
 * invalid draft shows its error without touching the node — so the canvas stays strict-valid.
 */
function JsonDraftField<T>({
  id,
  label,
  rows,
  initial,
  validate,
  identity,
  commit,
}: {
  id: string;
  label: string;
  rows: number;
  initial: () => string;
  validate: (text: string) => DraftResult<T>;
  identity: EditKey;
  commit: (value: T) => void;
}): JSX.Element {
  const { draft, error, onEdit } = useValidatedDraft(initial, validate, identity, commit);
  return (
    <div className="pane-field">
      <label className="pane-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="pane-input pane-json"
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        aria-invalid={error !== null}
        rows={rows}
      />
      <FieldError error={error} />
    </div>
  );
}

/** A field's validation error, announced to assistive tech; nothing when the draft is valid. */
function FieldError({ error }: { error: string | null }): JSX.Element | null {
  return error ? (
    <p className="pane-error" role="alert">
      {error}
    </p>
  ) : null;
}

// ── Node payload helpers ─────────────────────────────────────────────────────────────────────────

interface LeafEditorProps {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: EditCommit<WorkflowNode>;
}

