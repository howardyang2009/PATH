import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { type EditCommit, editKey } from "../edit-key.js";
import { editorTier, pluginFor } from "../editor-tiers.js";
import {
  configString,
  configStringOf,
  dropNodeKey,
  nodePayload,
  nodeString,
  rec,
  setNodeField,
  withConfig,
  withOptionalString,
} from "../node-edit.js";
import {
  CheckboxField,
  NumberField,
  SelectField,
  StringListField,
  TextAreaField,
  TextField,
} from "../pane-controls.js";
import { validateJsonPayload, validateOutputSchema } from "../validated-draft.js";
import { JsonDraftField } from "./fields.js";

// ── Node payload helpers ─────────────────────────────────────────────────────────────────────────

export interface LeafEditorProps {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: EditCommit<WorkflowNode>;
}

/** `prompt` — the first-class editor: the `model` (a config datum) and the `prompt` text, plus the worker. */
export function PromptEditor({ file, node, plugins, commit }: LeafEditorProps): JSX.Element {
  const prompt = nodeString(node, "prompt");
  const inheritedModel = configStringOf(file.config, "model");
  return (
    <>
      <ModelField
        value={configString(node, "model")}
        inherited={inheritedModel}
        onChange={(v) => commit(withConfig(node, "model", v), editKey(node.id, "config", "model"))}
      />
      <TextAreaField
        label="prompt"
        value={prompt}
        onChange={(v) => commit({ ...node, prompt: v } as WorkflowNode, editKey(node.id, "prompt"))}
      />
      <WorkerSelect file={file} node={node} plugins={plugins} commit={commit} />
    </>
  );
}

/**
 * The `model` line: a config datum, so it inherits from `config.model` like any key, but as a
 * first-class field it edits as an input, not a ghosted config row. Empty shows the inherited value as
 * a ghosted placeholder; typing overrides; **Revert** drops the local `model` and restores the inherited.
 */
export function ModelField({
  value,
  inherited,
  onChange,
}: {
  value: string;
  inherited: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const inheriting = value === "" && inherited !== "";
  const overridden = value !== "" && inherited !== "";
  // The wrapper renders in every state, only the Revert button toggling inside it, so appearing Revert
  // never re-parents (and re-mounts, dropping focus) the input being typed into.
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
          <button
            type="button"
            className="pane-btn"
            onClick={() => onChange("")}
            title={`Revert to the inherited model: ${inherited}`}
          >
            Revert
          </button>
        ) : null}
      </div>
    </label>
  );
}

/** `workflow`-ref — the first-class editor: the referenced file path. A workflow step carries no worker. */
export function WorkflowRefEditor({
  node,
  commit,
  onAddRefTarget,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  const ref = nodeString(node, "ref");
  // An empty ref on a file with a path offers the target chooser; otherwise the plain path field is the
  // editor, so a set ref stays retargetable by hand.
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
  return (
    <TextField
      label="referenced file"
      value={ref}
      onChange={(v) => commit({ ...node, ref: v } as WorkflowNode, editKey(node.id, "ref"))}
    />
  );
}

/**
 * `person-activity` — the three fields a Complete surface reads by node id (CONTEXT.md § Person-activity).
 * `description` is interpolable text the server resolves at Complete, so the pane neither resolves nor
 * validates it; `outputSchema` is the JSON Schema the Complete form is built from (ADR 0040); `assignee`
 * is an informational label with no enforcement. The worker is fixed (`person`), so no selector shows.
 */
export function PersonActivityEditor({
  node,
  commit,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
  const description = nodeString(node, "description");
  const assignee = nodeString(node, "assignee");
  return (
    <>
      <TextAreaField
        label="description"
        value={description}
        onChange={(v) =>
          commit(setNodeField(node, "description", v), editKey(node.id, "description"))
        }
      />
      <OutputSchemaField node={node} commit={commit} />
      <TextField
        label="assignee"
        value={assignee}
        onChange={(v) =>
          commit(withOptionalString(node, "assignee", v), editKey(node.id, "assignee"))
        }
      />
    </>
  );
}

/**
 * `person-activity`'s **outputSchema** — a live-validated JSON textarea: a valid object commits, an
 * empty box drops the key, and an unparseable draft shows its error but never commits.
 */
export function OutputSchemaField({
  node,
  commit,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
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
 * A generic registry leaf: the generated form when every field lays out, else the raw-JSON floor; both
 * carry the worker selector.
 */
export function LeafPayloadEditor({ file, node, plugins, commit }: LeafEditorProps): JSX.Element {
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
export function GenericForm({
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
        <GenericField
          key={name}
          name={name}
          spec={spec}
          value={record[name]}
          onChange={(v) => commit(setNodeField(node, name, v), editKey(node.id, name))}
        />
      ))}
    </>
  );
}

export function GenericField({
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
  const label = name;
  if (spec.type === "boolean") {
    return <CheckboxField label={label} value={value === true} onChange={onChange} />;
  }
  if (spec.type === "number") {
    return (
      <NumberField
        label={label}
        value={typeof value === "number" ? value : null}
        onChange={(n) => onChange(n ?? undefined)}
      />
    );
  }
  if (spec.type === "array") {
    const list = Array.isArray(value) ? value.map(String) : [];
    return (
      <StringListField
        label={label}
        values={list}
        onChange={(l) => onChange(l.length ? l : undefined)}
      />
    );
  }
  return (
    <TextField
      label={label}
      value={typeof value === "string" ? value : ""}
      onChange={(v) => onChange(v === "" ? undefined : v)}
    />
  );
}

/**
 * The raw-JSON floor: one live-validated textarea for the node's payload — every field outside the
 * identity/control envelope. On each edit it rebuilds the node and validates the whole file against the
 * registry (`safeParseWorkflowFile`); an invalid draft is **not** committed, so the canvas stays valid.
 */
export function RawJsonFloor({
  node,
  plugins,
  commit,
}: Omit<LeafEditorProps, "file">): JSX.Element {
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
 * The worker dropdown, shown only when the type ships more than one worker (§ Worker selection).
 *
 * An un-pinned step resolves through the file worker-default too (ADR 0044, `node.worker → launch →
 * file → type`), so the leading `(default)` option names the *effective* worker and its tier
 * (`(default: <worker> — file)`, else `— type`); choosing it drops `worker`. Picking a concrete worker
 * pins `node.worker`. The launch tier lives in no file, so it is never shown here.
 */
export function WorkerSelect({ file, node, plugins, commit }: LeafEditorProps): JSX.Element | null {
  const plugin = pluginFor(node.type, plugins);
  if (!plugin || plugin.workers.length <= 1) return null;
  const pinned = nodeString(node, "worker");
  const fileDefault = file.worker_defaults?.[node.type];
  // What an un-pinned step resolves to in the Designer's view: the file default, else the type's own.
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
