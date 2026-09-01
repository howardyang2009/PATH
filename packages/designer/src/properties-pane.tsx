import { useState } from "react";
import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";
import { safeParseWorkflowFile, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { locate, replaceNode } from "./edit-tree.js";
import { editorTier, pluginFor } from "./editor-tiers.js";
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

export interface PropertiesPaneProps {
  file: WorkflowFile;
  /** The selected node's id, or `null` for the file's own properties. */
  selectedId: string | null;
  plugins: WireStepPlugin[];
  applyEdit: (next: WorkflowFile) => void;
  /** Re-point the selection after a re-key changes a node's id (ADR 0015). */
  onReselect: (id: string) => void;
}

export function PropertiesPane({ file, selectedId, plugins, applyEdit, onReselect }: PropertiesPaneProps): JSX.Element {
  const node = selectedId === null ? null : [...walkNodes(file.body)].find((n) => n.id === selectedId) ?? null;
  if (node === null) {
    return <FileProperties file={file} applyEdit={applyEdit} />;
  }
  return <NodeProperties file={file} node={node} plugins={plugins} applyEdit={applyEdit} onReselect={onReselect} />;
}

// ── The file's own properties ──────────────────────────────────────────────────────────────────────

function FileProperties({ file, applyEdit }: { file: WorkflowFile; applyEdit: (next: WorkflowFile) => void }): JSX.Element {
  return (
    <div className="pane">
      <p className="pane-explain">The workflow file — its identity and the body authored on the canvas.</p>
      <hr className="pane-divider" />
      <TextField label="Name" value={file.name} onChange={(name) => applyEdit({ ...file, name })} />
      <IdRow id={file.id} onReKey={() => applyEdit({ ...file, id: crypto.randomUUID() })} what="the workflow" />
      <ReadOnlyRow label="Format" value={file.format} />
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
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  applyEdit: (next: WorkflowFile) => void;
  onReselect: (id: string) => void;
}): JSX.Element {
  const commit = (next: WorkflowNode): void => applyEdit(replaceNode(file, node.id, next));
  const reKey = (): void => {
    const id = crypto.randomUUID();
    applyEdit(replaceNode(file, node.id, { ...node, id }));
    onReselect(id);
  };
  const role = occupantRole(file, node.id);

  return (
    <div className="pane">
      {role ? (
        <p className="pane-role" role="note">
          {role}
        </p>
      ) : null}
      <p className="pane-explain">{kindExplanation(node.type)}</p>
      <hr className="pane-divider" />
      <TextField label="Name" value={node.name} onChange={(name) => commit({ ...node, name })} />
      <IdRow id={node.id} onReKey={reKey} what={`"${node.name}"`} />
      <KindFields node={node} plugins={plugins} commit={commit} />
    </div>
  );
}

/**
 * The role a node's container gives it (§ Pane layout, orientation before editing). Only a container
 * that distinguishes its occupants supplies one: a branch arm (its 1-based position among the arms), a
 * branch `else`, or a parallel branch. A file-body node, a `sequence` element, and a `while-do` body
 * carry no role — their position says nothing the block render does not already.
 */
function occupantRole(file: WorkflowFile, id: string): string | null {
  const site = locate(file, id);
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
  node,
  plugins,
  commit,
}: {
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: (next: WorkflowNode) => void;
}): JSX.Element {
  switch (node.type) {
    case "prompt":
      return <PromptEditor node={node} plugins={plugins} commit={commit} />;
    case "binary":
      return <BinaryEditor node={node} plugins={plugins} commit={commit} />;
    case "workflow":
      return <WorkflowRefEditor node={node} commit={commit} />;
    case "parallel":
      return (
        <SelectField
          label="Join"
          value={node.join}
          options={["collect", "wait-one", "do-not-wait"]}
          onChange={(join) => commit({ ...node, join: join as typeof node.join })}
        />
      );
    case "while-do":
      return (
        <NumberField
          label="Max iterations"
          value={typeof node.max_iterations === "number" ? node.max_iterations : null}
          onChange={(n) => commit({ ...node, max_iterations: n ?? 1 })}
        />
      );
    case "branch":
      return <p className="pane-hint">Arms and else are edited on the canvas; a Branch has no fields of its own.</p>;
    case "sequence":
      return <p className="pane-hint">Order is structure — reorder the body on the canvas.</p>;
    case "checkpoint":
      return <p className="pane-hint">The assertion condition is authored on the canvas summary.</p>;
    default:
      return <LeafPayloadEditor node={node} plugins={plugins} commit={commit} />;
  }
}

/** `prompt` — the first-class editor: the `model` (a config datum) and the `prompt` text, plus the worker. */
function PromptEditor({ node, plugins, commit }: LeafEditorProps): JSX.Element {
  const prompt = typeof (rec(node)).prompt === "string" ? ((rec(node)).prompt as string) : "";
  return (
    <>
      <TextField label="Model" value={configString(node, "model")} onChange={(v) => commit(withConfig(node, "model", v))} />
      <TextAreaField label="Prompt" value={prompt} onChange={(v) => commit({ ...node, prompt: v } as WorkflowNode)} />
      <WorkerSelect node={node} plugins={plugins} commit={commit} />
    </>
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
      <TextField label="Command" value={command} onChange={(v) => commit({ ...node, command: v } as WorkflowNode)} />
      <StringListField label="Args" values={args} onChange={(list) => commit(withOptionalArray(node, "args", list))} />
      <TextField label="Cwd" value={cwd} onChange={(v) => commit(withOptionalString(node, "cwd", v))} />
      <WorkerSelect node={node} plugins={plugins} commit={commit} />
    </>
  );
}

/** `workflow`-ref — the first-class editor: the referenced file path. A workflow step carries no worker. */
function WorkflowRefEditor({ node, commit }: { node: WorkflowNode; commit: (next: WorkflowNode) => void }): JSX.Element {
  const ref = typeof (rec(node)).ref === "string" ? ((rec(node)).ref as string) : "";
  return <TextField label="Referenced file" value={ref} onChange={(v) => commit({ ...node, ref: v } as WorkflowNode)} />;
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
  commit: (next: WorkflowNode) => void;
}): JSX.Element {
  const record = rec(node);
  return (
    <>
      {Object.entries(fields).map(([name, spec]) => (
        <GenericField key={name} name={name} spec={spec} value={record[name]} onChange={(v) => commit(setField(node, name, v))} />
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
  const label = titleCase(name);
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
    commit(next);
  };

  return (
    <div className="pane-field">
      <label className="pane-label" htmlFor="raw-json">
        Payload (JSON)
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
      label="Worker"
      value={current}
      options={plugin.workers}
      optionLabel={(w) => (w === plugin.default_worker ? `${w} (default)` : w)}
      onChange={onChange}
    />
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
    <div className="pane-field">
      <span className="pane-label">Id</span>
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
    <label className="pane-field">
      <span className="pane-label">{label}</span>
      <input className="pane-input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="pane-field">
      <span className="pane-label">{label}</span>
      <textarea className="pane-input" rows={5} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }): JSX.Element {
  return (
    <label className="pane-field">
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
    <label className="pane-field">
      <span className="pane-label">{label} (one per line)</span>
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
    <label className="pane-field">
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
    <div className="pane-field">
      <span className="pane-label">{label}</span>
      <code className="pane-id">{value}</code>
    </div>
  );
}

// ── Node payload helpers ─────────────────────────────────────────────────────────────────────────

interface LeafEditorProps {
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: (next: WorkflowNode) => void;
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
  const config = rec(node).config as Record<string, unknown> | undefined;
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

/** Title-case a field name for its label: `endpoint` → `Endpoint`, `api-key` → `Api-key`. */
function titleCase(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}
