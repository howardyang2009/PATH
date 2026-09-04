import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";
import {
  CONDITION_ROOTS,
  PUBLISH_ROOTS,
  STEP_ROOTS,
  checkInterpolationSyntax,
  isEnvWrapper,
  isSecretWrapper,
  safeParseWorkflowFile,
  walkNodes,
  type Condition,
  type ConfigObject,
  type ConfigValue,
  type EnvWrapper,
  type InterpolationRoot,
  type JsonValue,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { ConditionField } from "./condition-builder.js";
import { configRows, dropConfigKey, isEditableScalar, setConfigKey, type ConfigRow } from "./config-inheritance.js";
import { locate, replaceNode, setArmWhen } from "./edit-tree.js";
import { editorTier, pluginFor } from "./editor-tiers.js";
import { parseInputDraft, referenceablePaths } from "./interp-suggest.js";
import { wireToRegistry } from "./open-workflow.js";

/**
 * The properties pane (#369, designer-spec § Per-kind rendering and edit affordances, § Editors). A
 * single-click on a canvas node populates it; an empty-canvas click (`selectedId` `null`, or a node the
 * active file no longer holds) shows the **file's own** properties. Its layout is fixed top-to-bottom:
 * the node's **role** (only when its container gives one — a branch arm, a branch `else`, a parallel
 * branch), then a one-line **explanation** of the kind, a divider, then the editable fields — `name`
 * first, then `id` (with a confirmation-gated re-key, because a re-key breaks resume plan-reuse, ADR
 * 0015), then the kind-specific fields.
 *
 * The step editors are the three tiers (§ Editors): hand-built for `prompt` / `binary` / `workflow`, a
 * generated form for any other registry type, and a live-validated raw-JSON floor for a payload no form
 * can lay out — so every in-registry type always opens. The worker selector is a per-step dropdown shown
 * only when the type ships more than one worker (§ Worker selection); a single-worker type writes no
 * `worker` field.
 */

/** The envelope keys the raw-JSON floor never surfaces — identity, control, and the interpolation lines. */
const ENVELOPE_KEYS = new Set(["id", "name", "type", "worker", "config", "input", "parse", "publish"]);

/**
 * Tab in a pane field that shows a placeholder fills the placeholder in, instead of moving focus. A
 * placeholder only shows while the field is empty — a `${output.x}` reference hint, an inherited default
 * — so an author who wants exactly that value takes it with one key; a field that already holds text
 * shows no placeholder, so Tab keeps its normal focus-move there. Delegated from the pane root so it
 * covers every input and textarea without each control wiring its own handler. The value is written
 * through the element's native setter plus an `input` event, so React's controlled `onChange` runs and
 * the edit commits exactly as a keystroke would (a plain `.value =` would not notify React).
 */
function fillPlaceholderOnTab(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.value !== "" || el.placeholder === "") return;
  e.preventDefault();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setValue?.call(el, el.placeholder);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface PropertiesPaneProps {
  file: WorkflowFile;
  /** The selected node's id, or `null` for the file's own properties. */
  selectedId: string | null;
  plugins: WireStepPlugin[];
  applyEdit: (next: WorkflowFile, coalesce?: string) => void;
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
  const node = selectedId === null ? null : [...walkNodes(file.body)].find((n) => n.id === selectedId) ?? null;
  if (node === null) {
    return <FileProperties file={file} applyEdit={applyEdit} />;
  }
  return <NodeProperties file={file} node={node} plugins={plugins} applyEdit={applyEdit} onReselect={onReselect} onAddRefTarget={onAddRefTarget} />;
}

// ── The file's own properties ──────────────────────────────────────────────────────────────────────

function FileProperties({ file, applyEdit }: { file: WorkflowFile; applyEdit: (next: WorkflowFile, coalesce?: string) => void }): JSX.Element {
  return (
    <div className="pane" onKeyDown={fillPlaceholderOnTab}>
      <p className="pane-explain">The workflow file — its identity and the body authored on the canvas.</p>
      <hr className="pane-divider" />
      {/* A keystroke run in one field folds to one undo entry (#389); a per-field key breaks the run. */}
      <TextField label="name" value={file.name} onChange={(name) => applyEdit({ ...file, name }, "file:name")} />
      <IdRow id={file.id} onReKey={() => applyEdit({ ...file, id: crypto.randomUUID() })} what="the workflow" />
      <ReadOnlyRow label="format" value={file.format} />
      <hr className="pane-divider" />
      <FileConfigRegion key={`file-config-${file.id}`} file={file} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileOutputRegion key={`file-output-${file.id}`} file={file} applyEdit={applyEdit} />
    </div>
  );
}

/** A workflow-output entry the editor holds as a key and an interpolable-string value. */
interface OutputRow {
  key: string;
  value: string;
}

/** The file's `output` map read back as editor rows (each value coerced to its string form). */
function outputRowsOf(file: WorkflowFile): OutputRow[] {
  const output = (file as { output?: unknown }).output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [];
  return Object.entries(output as Record<string, unknown>).map(([key, value]) => ({
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
function FileOutputRegion({ file, applyEdit }: { file: WorkflowFile; applyEdit: (next: WorkflowFile, coalesce?: string) => void }): JSX.Element {
  const [rows, setRows] = useState<OutputRow[]>(() => outputRowsOf(file));

  // A row edit passes a per-row `coalesce` key so a keystroke run in one row folds to one undo entry
  // (#389); add/remove pass none, so each is its own entry.
  const writeRows = (next: OutputRow[], coalesce?: string): void => {
    setRows(next);
    const named = next.filter((row) => row.key !== "");
    if (named.some((row) => !checkInterpolationSyntax(row.value, STEP_ROOTS).ok)) return;
    const map: Record<string, string> = {};
    for (const row of named) map[row.key] = row.value;
    if (Object.keys(map).length === 0) {
      const { output: _dropped, ...rest } = file as WorkflowFile & { output?: unknown };
      applyEdit(rest as WorkflowFile, coalesce);
    } else {
      applyEdit({ ...file, output: map } as WorkflowFile, coalesce);
    }
  };
  const setRow = (index: number, row: OutputRow): void => writeRows(rows.map((r, i) => (i === index ? row : r)), `file-output:${index}`);
  const addRow = (): void => writeRows([...rows, { key: "", value: "" }]);
  const removeRow = (index: number): void => writeRows(rows.filter((_, i) => i !== index));

  return (
    <div className="pane-section">
      <span className="pane-section-title">output</span>
      <p className="pane-hint">The workflow's output object, evaluated at success — what a parent's publish reads back from a workflow reference.</p>
      {rows.length > 0 ? (
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <OutputRowField key={index} row={row} onChange={(r) => setRow(index, r)} onRemove={() => removeRow(index)} />
          ))}
        </div>
      ) : null}
      <button type="button" className="pane-btn" onClick={addRow}>
        + add output key
      </button>
    </div>
  );
}

/** One output row: a key and its interpolable value, live-checked against the output roots (`config`/`context`). */
function OutputRowField({ row, onChange, onRemove }: { row: OutputRow; onChange: (row: OutputRow) => void; onRemove: () => void }): JSX.Element {
  const check = checkInterpolationSyntax(row.value, STEP_ROOTS);
  // The value placeholder mirrors the key the author typed — `${context.<key>}` — the most common output:
  // land the step context value of the same name. It falls back to `${context.key}` before a key is typed.
  const valuePlaceholder = `\${context.${row.key === "" ? "key" : row.key}}`;
  return (
    <div className="pane-publish-row">
      <input className="pane-input" type="text" aria-label="Output key" placeholder="output key" value={row.key} onChange={(e) => onChange({ ...row, key: e.target.value })} />
      <span className="pane-publish-eq" aria-hidden="true">=</span>
      <div className="pane-publish-value">
        <input className="pane-input" type="text" aria-label="Output value" placeholder={valuePlaceholder} value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} aria-invalid={!check.ok} />
        <button type="button" className="pane-btn" aria-label="Remove output" onClick={onRemove}>
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
  applyEdit: (next: WorkflowFile, coalesce?: string) => void;
  onReselect: (id: string) => void;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  // A field edit passes a stable per-field `coalesce` key so a run of keystrokes folds to one undo entry
  // (#389); a discrete change (a select, a re-key) passes none, so it is its own entry.
  const commit = (next: WorkflowNode, coalesce?: string): void => applyEdit(replaceNode(file, node.id, next), coalesce);
  const reKey = (): void => {
    const id = crypto.randomUUID();
    applyEdit(replaceNode(file, node.id, { ...node, id }));
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
      <TextField label="name" value={node.name} onChange={(name) => commit({ ...node, name }, `name:${node.id}`)} />
      <IdRow id={node.id} onReKey={reKey} what={`"${node.name}"`} />
      {site?.where === "arm" ? (
        <ConditionField
          key={`when-${node.id}`}
          label="when"
          condition={armWhen(file, site.ownerId, site.armIndex)}
          suggestions={condSuggest}
          onChange={(when) => applyEdit(setArmWhen(file, site.ownerId, site.armIndex, when))}
        />
      ) : null}
      <KindFields file={file} node={node} plugins={plugins} commit={commit} condSuggest={condSuggest} onAddRefTarget={onAddRefTarget} />
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
  const paths = referenceablePaths(file, [...roots]);
  if (paths.length === 0) return null;
  return (
    <>
      <hr className="pane-divider" />
      <div className="pane-section pane-reference">
        <span className="pane-section-title">reference</span>
        <p className="pane-hint pane-suggest">{paths.join(" · ")}</p>
      </div>
    </>
  );
}

/** The six control-construct types (they carry no `config`/`input`/`parse`/`publish` envelope). */
const CONTROL_TYPES = new Set(["parallel", "branch", "while-do", "sequence", "checkpoint"]);

/** Does this node type carry the step envelope (`config` / `input` / `parse` / `publish`)? `workflow` does; the control blocks do not. */
function carriesEnvelope(type: string): boolean {
  return !CONTROL_TYPES.has(type);
}

/** The `when` condition of a branch arm, read back off the parent branch for the pane's builder. */
function armWhen(file: WorkflowFile, branchId: string, armIndex: number): Condition {
  const owner = [...walkNodes(file.body)].find((n) => n.id === branchId);
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
    const owner = [...walkNodes(file.body)].find((n) => n.id === site.ownerId);
    const total = owner?.type === "branch" ? owner.arms.length : 0;
    return `branch arm (${site.armIndex + 1} of ${total})`;
  }
  return null;
}

/** The one-line explanation of a node kind, shown above the divider (§ Pane layout, explanatory copy). */
function kindExplanation(type: string): string {
  switch (type) {
    case "prompt":
      return "An LLM prompt run against a model.";
    case "binary":
      return "A command run with arguments in a working directory.";
    case "workflow":
      return "A reference to another workflow file, run as a nested run.";
    case "parallel":
      return "Runs its branches together; the join mode decides how their outputs land.";
    case "branch":
      return "First-match-wins arms, each guarded by a condition, with an optional else.";
    case "while-do":
      return "Repeats one body while a condition holds, up to a maximum count.";
    case "sequence":
      return "An ordered stack of nodes, run one after another.";
    case "checkpoint":
      return "Asserts a condition on the run; a failed assertion fails the run.";
    default:
      return `A ${type} step.`;
  }
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
  commit: (next: WorkflowNode, coalesce?: string) => void;
  condSuggest: string[];
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  switch (node.type) {
    case "prompt":
      return <PromptEditor file={file} node={node} plugins={plugins} commit={commit} />;
    case "binary":
      return <BinaryEditor node={node} plugins={plugins} commit={commit} />;
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
            key={`condition-${node.id}`}
            label="condition"
            condition={node.condition}
            suggestions={condSuggest}
            onChange={(condition) => commit({ ...node, condition })}
          />
          <MaxIterationsField
            key={`max-iterations-${node.id}`}
            value={node.max_iterations}
            onChange={(v) => commit({ ...node, max_iterations: v }, `max_iterations:${node.id}`)}
          />
        </>
      );
    case "branch":
      return <p className="pane-hint">Arms and else are edited on the canvas; a Branch has no fields of its own.</p>;
    case "sequence":
      return <p className="pane-hint">Order is structure — reorder the body on the canvas.</p>;
    case "checkpoint":
      return (
        <ConditionField
          key={`condition-${node.id}`}
          label="condition"
          condition={node.condition}
          suggestions={condSuggest}
          onChange={(condition) => commit({ ...node, condition })}
        />
      );
    default:
      return <LeafPayloadEditor node={node} plugins={plugins} commit={commit} />;
  }
}

/** `prompt` — the first-class editor: the `model` (a config datum) and the `prompt` text, plus the worker. */
function PromptEditor({ file, node, plugins, commit }: LeafEditorProps & { file: WorkflowFile }): JSX.Element {
  const prompt = typeof (rec(node)).prompt === "string" ? ((rec(node)).prompt as string) : "";
  const inheritedModel = configStringOf(file.config, "model");
  return (
    <>
      <ModelField
        value={configString(node, "model")}
        inherited={inheritedModel}
        onChange={(v) => commit(withConfig(node, "model", v), `config.model:${node.id}`)}
      />
      <TextAreaField label="prompt" value={prompt} onChange={(v) => commit({ ...node, prompt: v } as WorkflowNode, `prompt:${node.id}`)} />
      <WorkerSelect node={node} plugins={plugins} commit={commit} />
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

/** `binary` — the first-class editor: the `command`, its `args`, its `cwd`, plus the worker. */
function BinaryEditor({ node, plugins, commit }: LeafEditorProps): JSX.Element {
  const record = rec(node);
  const command = typeof record.command === "string" ? record.command : "";
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const args = Array.isArray(record.args) ? (record.args as unknown[]).map(String) : [];
  return (
    <>
      <TextField label="command" value={command} onChange={(v) => commit({ ...node, command: v } as WorkflowNode, `command:${node.id}`)} />
      <StringListField label="args" values={args} onChange={(list) => commit(withOptionalArray(node, "args", list), `args:${node.id}`)} />
      <TextField label="cwd" value={cwd} onChange={(v) => commit(withOptionalString(node, "cwd", v), `cwd:${node.id}`)} />
      <WorkerSelect node={node} plugins={plugins} commit={commit} />
    </>
  );
}

/** `workflow`-ref — the first-class editor: the referenced file path. A workflow step carries no worker. */
function WorkflowRefEditor({
  node,
  commit,
  onAddRefTarget,
}: {
  node: WorkflowNode;
  commit: (next: WorkflowNode, coalesce?: string) => void;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  const ref = typeof (rec(node)).ref === "string" ? ((rec(node)).ref as string) : "";
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
  return <TextField label="referenced file" value={ref} onChange={(v) => commit({ ...node, ref: v } as WorkflowNode, `ref:${node.id}`)} />;
}

/**
 * A generic registry leaf: the generated form when every field lays out, else the raw-JSON floor. Both
 * carry the worker selector. `editorTier` has already decided which tier this type takes; this switch
 * just renders it.
 */
function LeafPayloadEditor({ node, plugins, commit }: LeafEditorProps): JSX.Element {
  const tier = editorTier(node.type, plugins);
  const plugin = pluginFor(node.type, plugins);
  return (
    <>
      {tier === "generic" && plugin ? (
        <GenericForm node={node} fields={plugin.fields} commit={commit} />
      ) : (
        <RawJsonFloor key={node.id} node={node} plugins={plugins} commit={commit} />
      )}
      <WorkerSelect node={node} plugins={plugins} commit={commit} />
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
  commit: (next: WorkflowNode, coalesce?: string) => void;
}): JSX.Element {
  const record = rec(node);
  return (
    <>
      {Object.entries(fields).map(([name, spec]) => (
        <GenericField key={name} name={name} spec={spec} value={record[name]} onChange={(v) => commit(setField(node, name, v), `field:${name}:${node.id}`)} />
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
function RawJsonFloor({ node, plugins, commit }: LeafEditorProps): JSX.Element {
  const [draft, setDraft] = useState(() => JSON.stringify(payloadOf(node), null, 2));
  const [error, setError] = useState<string | null>(null);

  const onEdit = (text: string): void => {
    setDraft(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("The payload must be a JSON object.");
      return;
    }
    const next = mergePayload(node, parsed as Record<string, unknown>);
    const validated = validateNode(next, plugins);
    if (validated) {
      setError(validated);
      return;
    }
    setError(null);
    commit(next, `payload:${node.id}`);
  };

  return (
    <div className="pane-field">
      <label className="pane-label" htmlFor="raw-json">
        payload (JSON)
      </label>
      <textarea
        id="raw-json"
        className="pane-input pane-json"
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        aria-invalid={error !== null}
        rows={8}
      />
      {error ? (
        <p className="pane-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The worker dropdown — shown only when the type ships more than one worker (§ Worker selection). */
function WorkerSelect({ node, plugins, commit }: LeafEditorProps): JSX.Element | null {
  const plugin = pluginFor(node.type, plugins);
  if (!plugin || plugin.workers.length <= 1) return null;
  const current = typeof (rec(node)).worker === "string" ? ((rec(node)).worker as string) : plugin.default_worker;
  const onChange = (worker: string): void => {
    // The default is the omitted case (a step naming no worker takes the type's default), so selecting
    // it drops the field rather than pinning it (§ Worker selection).
    if (worker === plugin.default_worker) commit(dropKey(node, "worker"));
    else commit(setField(node, "worker", worker));
  };
  return (
    <SelectField
      label="worker"
      value={current}
      options={plugin.workers}
      optionLabel={(w) => (w === plugin.default_worker ? `${w} (default)` : w)}
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
function StepEnvelopeFields({ file, node, commit }: { file: WorkflowFile; node: WorkflowNode; commit: (next: WorkflowNode, coalesce?: string) => void }): JSX.Element {
  return (
    <>
      <hr className="pane-divider" />
      <ConfigRegion key={`config-${node.id}`} file={file} node={node} commit={commit} />
      <InputEditor key={`input-${node.id}`} node={node} commit={commit} />
      <PublishParseFields key={`publish-${node.id}`} node={node} commit={commit} />
    </>
  );
}

/** The node's own `config` object, or `undefined` when it carries none. */
function nodeConfigOf(node: WorkflowNode): ConfigObject | undefined {
  const config = rec(node).config;
  return config !== null && typeof config === "object" && !Array.isArray(config) ? (config as ConfigObject) : undefined;
}

/** Write (or drop) a node's `config`, keeping the node otherwise intact. */
function applyNodeConfig(node: WorkflowNode, config: ConfigObject | undefined): WorkflowNode {
  return config === undefined ? dropKey(node, "config") : ({ ...node, config } as WorkflowNode);
}

/**
 * The config-inheritance region (§ Config inheritance display): an inherited key ghosted read-only with
 * its origin and an **Override**; an overridden key solid with a **revert-to-inherited**; a local key
 * solid. The `type` field never appears here — it edits in the kind-fields region and does not inherit.
 */
function ConfigRegion({ file, node, commit }: { file: WorkflowFile; node: WorkflowNode; commit: (next: WorkflowNode, coalesce?: string) => void }): JSX.Element {
  const config = nodeConfigOf(node);
  // A value edit passes a per-key `coalesce` so a keystroke run in one config value folds to one undo
  // entry (#389); a discrete write (Override/Revert/×/add-key) passes none, so it is its own entry.
  const write = (next: ConfigObject | undefined, coalesce?: string): void => commit(applyNodeConfig(node, next), coalesce);
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
 * whose config *is* the root every step inherits from. `scopeId` scopes each value's `coalesce` key so
 * two owners' same-named keys never fold their undo runs together (#389).
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
  write: (next: ConfigObject | undefined, coalesce?: string) => void;
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
    <div className="pane-section">
      <span className="pane-section-title">config</span>
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
    </div>
  );
}

/**
 * The file's own **config** (§ Config inheritance display): the workflow-level defaults every step
 * inherits. Unlike a step's region there is no parent to inherit from — the file's config *is* the root
 * — so every key renders local (add / edit as literal · `$env` · `$secret` / remove). A cleared config
 * drops the whole `config` field, so an empty `config: {}` never lands in the file.
 */
function FileConfigRegion({ file, applyEdit }: { file: WorkflowFile; applyEdit: (next: WorkflowFile, coalesce?: string) => void }): JSX.Element {
  const write = (next: ConfigObject | undefined, coalesce?: string): void => {
    if (next === undefined) {
      const { config: _dropped, ...rest } = file;
      applyEdit(rest as WorkflowFile, coalesce);
    } else {
      applyEdit({ ...file, config: next }, coalesce);
    }
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

/** One config row, rendered by origin: inherited (ghosted + Override), overridden (revert), or local. */
function ConfigRowField({
  row,
  config,
  nodeId,
  write,
}: {
  row: ConfigRow;
  config: ConfigObject | undefined;
  /** The owning node's id — scopes the value's coalesce key so two nodes' same-named keys never fold (#389). */
  nodeId: string;
  write: (next: ConfigObject | undefined, coalesce?: string) => void;
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
        <ConfigValueControl value={row.value} onChange={(v) => write(setConfigKey(config, row.key, v), `config:${row.key}:${nodeId}`)} label={row.key} />
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

/** The three authoring modes a config value takes in the pane (§ `$env` / `$secret` authoring, map decision 9). */
type ConfigMode = "literal" | "env" | "secret";

/** Which mode a config value is in, read off its shape: a `$secret` wrapper, an `$env` wrapper, or a plain literal. */
function configModeOf(value: ConfigValue): ConfigMode {
  if (isSecretWrapper(value)) return "secret";
  if (isEnvWrapper(value)) return "env";
  return "literal";
}

/** The `$env` variable name carried anywhere in a value (bare `$env`, or an env-sourced `$secret`), for mode-switch reuse. */
function envNameOf(value: ConfigValue): string {
  if (isEnvWrapper(value)) return value.$env;
  if (isSecretWrapper(value) && isEnvWrapper(value.$secret)) return value.$secret.$env;
  return "";
}

/**
 * The reference-only label of a wrapper — never a resolved value (§ Display is reference-only). An `$env`
 * shows its variable name; a `$secret` shows a masked, named token (the env name when sourced from `$env`,
 * masked bullets for a literal secret). A plain scalar or nested value returns `null` (it is not a reference).
 */
function referenceLabel(value: ConfigValue): string | null {
  if (isSecretWrapper(value)) {
    return isEnvWrapper(value.$secret) ? `$secret · $env · ${value.$secret.$env}` : "$secret · ••••••";
  }
  if (isEnvWrapper(value)) return `$env · ${value.$env}`;
  return null;
}

/** The props the config-value control and its three mode sub-controls share (§ `$env` / `$secret` authoring). */
interface ConfigControlProps {
  value: ConfigValue;
  onChange: (v: ConfigValue) => void;
  label: string;
}

/**
 * A typed control for a config value with its `Literal` / `$env` / `$secret` mode selector (map decision 9).
 * The composed `{"$secret": {"$env": …}}` is expressible through the `$secret` source sub-selector. A nested
 * array/object that is not a wrapper stays read-only — that authoring is out of this affordance's scope.
 */
function ConfigValueControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  if (!isEditableScalar(value) && referenceLabel(value) === null) {
    return <code className="pane-config-value">{renderConfigValue(value)}</code>;
  }
  const mode = configModeOf(value);
  const setMode = (next: ConfigMode): void => {
    if (next === mode) return;
    if (next === "literal") onChange("");
    else if (next === "env") onChange({ $env: envNameOf(value) });
    else onChange({ $secret: envNameOf(value) === "" ? "" : { $env: envNameOf(value) } });
  };
  return (
    <div className="pane-config-control">
      <select
        className="pane-input pane-config-mode"
        aria-label={`${label} mode`}
        value={mode}
        onChange={(e) => setMode(e.target.value as ConfigMode)}
      >
        <option value="literal">Literal</option>
        <option value="env">$env</option>
        <option value="secret">$secret</option>
      </select>
      {mode === "literal" ? <LiteralControl value={value} onChange={onChange} label={label} /> : null}
      {mode === "env" ? <EnvControl value={value} onChange={onChange} label={label} /> : null}
      {mode === "secret" ? <SecretControl value={value} onChange={onChange} label={label} /> : null}
    </div>
  );
}

/** The literal-mode control: a typed input matching the scalar's own type (boolean / number / string). */
function LiteralControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  if (typeof value === "boolean") {
    return <input type="checkbox" aria-label={label} checked={value} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (typeof value === "number") {
    return <input className="pane-input" type="number" aria-label={label} value={value} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
  }
  return <input className="pane-input" type="text" aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
}

/** The `$env`-mode control: an env-var-name input plus the reference-only chip (`$env · NAME`). */
function EnvControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  const name = isEnvWrapper(value) ? value.$env : "";
  return (
    <div className="pane-ref-control">
      <input
        className="pane-input"
        type="text"
        aria-label={`${label} $env variable`}
        placeholder="ENV_VAR_NAME"
        value={name}
        onChange={(e) => onChange({ $env: e.target.value })}
      />
      <code className="pane-ref-token" data-ref="env">
        {referenceLabel({ $env: name })}
      </code>
    </div>
  );
}

/**
 * The `$secret`-mode control: a source sub-selector (a literal secret, or one sourced from `$env`) and the
 * matching input, plus the masked, named token. A literal secret edits through a password field so the
 * pane never renders the value; the composed `{"$secret": {"$env": …}}` is the env-sourced source.
 */
function SecretControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  const inner: string | EnvWrapper = isSecretWrapper(value) ? value.$secret : "";
  const setSource = (source: "literal" | "env"): void => {
    if (source === "env") onChange({ $secret: { $env: isEnvWrapper(inner) ? inner.$env : "" } });
    else onChange({ $secret: "" });
  };
  return (
    <div className="pane-ref-control">
      <select
        className="pane-input pane-secret-source"
        aria-label={`${label} $secret source`}
        value={isEnvWrapper(inner) ? "env" : "literal"}
        onChange={(e) => setSource(e.target.value as "literal" | "env")}
      >
        <option value="literal">Literal secret</option>
        <option value="env">From $env</option>
      </select>
      {isEnvWrapper(inner) ? (
        <input
          className="pane-input"
          type="text"
          aria-label={`${label} $secret $env variable`}
          placeholder="ENV_VAR_NAME"
          value={inner.$env}
          onChange={(e) => onChange({ $secret: { $env: e.target.value } })}
        />
      ) : (
        <input
          className="pane-input"
          type="password"
          aria-label={`${label} $secret value`}
          placeholder="secret"
          value={inner}
          onChange={(e) => onChange({ $secret: e.target.value })}
        />
      )}
      <code className="pane-ref-token" data-ref="secret">
        {referenceLabel({ $secret: inner })}
      </code>
    </div>
  );
}

/** A config value for read-only display (an inherited ghost): a wrapper as its reference-only label, a scalar as itself, else compact JSON. */
function renderConfigValue(value: ConfigValue): string {
  const reference = referenceLabel(value);
  if (reference !== null) return reference;
  if (isEditableScalar(value)) return String(value);
  return JSON.stringify(value);
}

/**
 * The interpolable **input** object (§ Input/output wiring): one live-validated JSON textarea whose
 * `${…}` placeholders reference `config.` / `context.` dot-paths — the roots the schema allows a step to
 * read *before it runs* (`STEP_ROOTS`; a step's own `output` does not exist yet). It validates against
 * exactly those roots, so the pane accepts only what a load-time parse would; an unclosed or ill-typed
 * placeholder is reported and never committed, and the referenceable paths are offered as autocomplete.
 */
function InputEditor({ node, commit }: { node: WorkflowNode; commit: (next: WorkflowNode, coalesce?: string) => void }): JSX.Element {
  const initial = (): string => {
    const input = rec(node).input;
    return input === undefined ? "{}" : JSON.stringify(input, null, 2);
  };
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const onEdit = (text: string): void => {
    setDraft(text);
    const parsed = parseInputDraft(text, STEP_ROOTS);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    // An empty draft or an empty object `{}` means "no input", so drop the key. Every other value — a
    // bare `${context.x}` whole-string, a literal, an array, a populated object (§6.1) — is a real input
    // and is kept.
    const isEmptyObject =
      parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value) && Object.keys(parsed.value).length === 0;
    const isEmpty = text.trim() === "" || isEmptyObject;
    commit(isEmpty ? dropKey(node, "input") : ({ ...node, input: parsed.value } as WorkflowNode), `input:${node.id}`);
  };

  return (
    <div className="pane-section">
      <span className="pane-section-title">input</span>
      <div className="pane-field">
        <label className="pane-label" htmlFor={`input-${node.id}`}>
          input (any JSON value, ${"{…}"} interpolable)
        </label>
        <textarea
          id={`input-${node.id}`}
          className="pane-input pane-json"
          value={draft}
          onChange={(e) => onEdit(e.target.value)}
          aria-invalid={error !== null}
          rows={5}
        />
        {error ? (
          <p className="pane-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A publish entry the editor holds as a key and an interpolable-string value. */
interface PublishRow {
  key: string;
  value: string;
}

/** The node's `publish` map read back as editor rows (each value coerced to its string form). */
function publishRowsOf(node: WorkflowNode): PublishRow[] {
  const publish = rec(node).publish;
  if (publish === null || typeof publish !== "object" || Array.isArray(publish)) return [];
  return Object.entries(publish as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/**
 * The context-**write** fields (§ Context reads and writes): `publish` (a `key → ${…}` map, each value an
 * interpolable string over `config.`/`context.`/`output.`) and `parse`. These are pane fields on the step,
 * never canvas edges. A publish conflict the load-time checks reject surfaces separately, as a node
 * validation marker on the canvas (`publish-conflicts.ts`).
 */
function PublishParseFields({ node, commit }: { node: WorkflowNode; commit: (next: WorkflowNode, coalesce?: string) => void }): JSX.Element {
  const [rows, setRows] = useState<PublishRow[]>(() => publishRowsOf(node));
  const parse = typeof rec(node).parse === "string" ? (rec(node).parse as string) : "";

  // Hold the rows as a draft and commit only when every value's interpolation is valid, so an ill-typed
  // `${…}` publish never reaches the file — the node stays strict-valid (§ Context reads and writes).
  // A row edit passes a per-row `coalesce` key so a keystroke run in one publish row folds to one undo
  // entry (#389); add/remove pass none, so each is its own entry.
  const writeRows = (next: PublishRow[], coalesce?: string): void => {
    setRows(next);
    const named = next.filter((row) => row.key !== "");
    if (named.some((row) => !checkInterpolationSyntax(row.value, PUBLISH_ROOTS).ok)) return;
    const map: Record<string, string> = {};
    for (const row of named) map[row.key] = row.value;
    commit(Object.keys(map).length === 0 ? dropKey(node, "publish") : ({ ...node, publish: map } as WorkflowNode), coalesce);
  };
  const setRow = (index: number, row: PublishRow): void => writeRows(rows.map((r, i) => (i === index ? row : r)), `publish:${index}:${node.id}`);
  const addRow = (): void => writeRows([...rows, { key: "", value: "" }]);
  const removeRow = (index: number): void => writeRows(rows.filter((_, i) => i !== index));

  return (
    <div className="pane-section">
      <span className="pane-section-title">context writes</span>
      {rows.length > 0 ? (
        // One shared grid so every row's `=` sits in the same column, aligned down the list (§ Config).
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <PublishRowField key={index} row={row} onChange={(r) => setRow(index, r)} onRemove={() => removeRow(index)} />
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
        onChange={(v) => commit(v === "(none)" ? dropKey(node, "parse") : (setField(node, "parse", v)))}
      />
    </div>
  );
}

/** One publish row: a context key and its interpolable value, the value live-checked against the publish roots. */
function PublishRowField({ row, onChange, onRemove }: { row: PublishRow; onChange: (row: PublishRow) => void; onRemove: () => void }): JSX.Element {
  const check = checkInterpolationSyntax(row.value, PUBLISH_ROOTS);
  // One publish datum on one line: `key = value ×`. The row is transparent to the grid (`display: contents`)
  // so its key, `=`, and value cell share the section grid and the `=` lines up down the list (§ Config).
  return (
    <div className="pane-publish-row">
      <input className="pane-input" type="text" aria-label="Publish key" placeholder="context key" value={row.key} onChange={(e) => onChange({ ...row, key: e.target.value })} />
      <span className="pane-publish-eq" aria-hidden="true">=</span>
      <div className="pane-publish-value">
        <input className="pane-input" type="text" aria-label="Publish value" placeholder="${output.x}" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} aria-invalid={!check.ok} />
        <button type="button" className="pane-btn" aria-label="Remove publish" onClick={onRemove}>
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

// ── Identity controls ────────────────────────────────────────────────────────────────────────────

/**
 * The `id` row: the read-only id and a confirmation-gated re-key (§ Pane layout). A re-key is guarded
 * because it mints a new id, which breaks resume plan-reuse (ADR 0015) — so the button first arms a
 * confirm/cancel, and only Confirm commits the new id.
 */
function IdRow({ id, onReKey, what }: { id: string; onReKey: () => void; what: string }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pane-field pane-field-row">
      <span className="pane-label">id</span>
      <div className="pane-id-row">
        <code className="pane-id">{id}</code>
        {confirming ? (
          <span className="pane-rekey-confirm">
            <button
              type="button"
              className="pane-btn pane-btn-danger"
              onClick={() => {
                onReKey();
                setConfirming(false);
              }}
            >
              Confirm re-key
            </button>
            <button type="button" className="pane-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="pane-btn" onClick={() => setConfirming(true)}>
            Re-key
          </button>
        )}
      </div>
      {confirming ? (
        <p className="pane-warn" role="alert">
          Re-keying {what} mints a new id and breaks resume plan-reuse for existing runs.
        </p>
      ) : null}
    </div>
  );
}

// ── Small typed field controls ───────────────────────────────────────────────────────────────────

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <input className="pane-input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="pane-field pane-field-row pane-field-multiline">
      <span className="pane-label">{label}</span>
      <textarea className="pane-input" rows={5} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <input
        className="pane-input"
        type="number"
        value={value === null ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

/**
 * `while-do`'s **max iterations**. The schema takes either a positive whole number or a `${config.…}` /
 * `${context.…}` interpolation over the step roots (`MaxIterationsSchema`, `STEP_ROOTS`), so the pane
 * cannot be a number-only input — a number-only field can never point the cap at a workflow config datum
 * like `${config.max_revisions}`. It is a text field held as a draft: a run of digits commits as a
 * number, an interpolation commits as a string once its `${…}` syntax checks out, and anything else is
 * flagged and not committed — so the node on the canvas stays strict-valid.
 */
function MaxIterationsField({
  value,
  onChange,
}: {
  value: number | string;
  onChange: (v: number | string) => void;
}): JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState(() => String(value));
  const [error, setError] = useState<string | null>(null);

  const onEdit = (text: string): void => {
    setDraft(text);
    const trimmed = text.trim();
    if (trimmed === "") {
      setError("Required — a positive whole number, or a ${config.…} / ${context.…} reference.");
      return;
    }
    // A run of digits is a literal count; anything else is checked as an interpolation over the step
    // roots (`config` / `context`), the same roots a step may read before it runs.
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n < 1) {
        setError("Must be a positive whole number.");
        return;
      }
      setError(null);
      onChange(n);
      return;
    }
    const check = checkInterpolationSyntax(text, STEP_ROOTS);
    if (!check.ok) {
      setError(check.error ?? "Invalid interpolation.");
      return;
    }
    setError(null);
    onChange(text);
  };

  return (
    <div className="pane-field pane-field-row">
      <label className="pane-label" htmlFor={id}>
        max iterations
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
      {error ? (
        <p className="pane-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CheckboxField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="pane-field pane-field-inline">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="pane-label">{label}</span>
    </label>
  );
}

function StringListField({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }): JSX.Element {
  return (
    <label className="pane-field pane-field-row pane-field-multiline">
      <span className="pane-label">
        {label}
        <span className="pane-label-note">(one per line)</span>
      </span>
      <textarea
        className="pane-input"
        rows={3}
        value={values.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n").filter((line) => line.length > 0))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  optionLabel?: (option: string) => string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <select className="pane-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel ? optionLabel(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="pane-field pane-field-row">
      <span className="pane-label">{label}</span>
      <code className="pane-id">{value}</code>
    </div>
  );
}

// ── Node payload helpers ─────────────────────────────────────────────────────────────────────────

interface LeafEditorProps {
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: (next: WorkflowNode, coalesce?: string) => void;
}

/** A node as an open record — the discriminated union carries no index signature, so payload reads go through here. */
function rec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

/** The node's payload — every key outside the identity/control envelope (what the raw-JSON floor edits). */
function payloadOf(node: WorkflowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Rebuild a node from its envelope plus a fresh payload (envelope keys in the payload are ignored). */
function mergePayload(node: WorkflowNode, payload: Record<string, unknown>): WorkflowNode {
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ENVELOPE_KEYS.has(key)) cleaned[key] = value;
  }
  return { ...envelope, ...cleaned } as unknown as WorkflowNode;
}

/** Set a payload/envelope key on a node (an `undefined` value drops the key), returning a new node. */
function setField(node: WorkflowNode, key: string, value: unknown): WorkflowNode {
  if (value === undefined) return dropKey(node, key);
  return { ...node, [key]: value } as WorkflowNode;
}

/** Drop a key from a node, returning a new node without it. */
function dropKey(node: WorkflowNode, key: string): WorkflowNode {
  const { [key]: _dropped, ...rest } = rec(node);
  return rest as unknown as WorkflowNode;
}

/** An optional string field: set it when non-empty, drop it when empty. */
function withOptionalString(node: WorkflowNode, key: string, value: string): WorkflowNode {
  return value === "" ? dropKey(node, key) : setField(node, key, value);
}

/** An optional array field: set it when non-empty, drop it when empty. */
function withOptionalArray(node: WorkflowNode, key: string, value: string[]): WorkflowNode {
  return value.length === 0 ? dropKey(node, key) : setField(node, key, value);
}

/** Read a string config datum off a node (e.g. `prompt`'s `model`), or `""` when absent. */
function configString(node: WorkflowNode, key: string): string {
  return configStringOf(rec(node).config as Record<string, unknown> | undefined, key);
}

/** Read a string value off a config object (a node's or the file's), or `""` when absent or non-string. */
function configStringOf(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Write a string config datum on a node, dropping the key (and an emptied `config`) when cleared. This
 * is the one config touch #369 owns — the `model` line named in the spec's prompt editor. The full
 * inherited-vs-overridden config editor (§ Config inheritance display) is a later #254 ticket.
 */
function withConfig(node: WorkflowNode, key: string, value: string): WorkflowNode {
  const config: Record<string, unknown> = { ...((rec(node).config as Record<string, unknown> | undefined) ?? {}) };
  if (value === "") delete config[key];
  else config[key] = value;
  if (Object.keys(config).length === 0) return dropKey(node, "config");
  return { ...node, config } as WorkflowNode;
}

/** Validate a prospective node inside a one-node file against the registry; returns an error, or `null` if valid. */
function validateNode(node: WorkflowNode, plugins: WireStepPlugin[]): string | null {
  const trial: WorkflowFile = { format: "path/workflow@3", id: crypto.randomUUID(), name: "trial", body: [node] };
  const result = safeParseWorkflowFile(trial, wireToRegistry(plugins));
  return result.success ? null : result.errors.join("\n");
}

