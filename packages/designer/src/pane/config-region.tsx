import {
  type ConfigObject,
  PUBLISH_ROOTS,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { useState } from "react";
import { type ConfigRow, configRows, dropConfigKey, setConfigKey } from "../config-inheritance.js";
import { renderConfigValue } from "../config-value.js";
import { ConfigValueControl } from "../config-value-control.js";
import { type EditCommit, type EditKey, editKey } from "../edit-key.js";
import {
  applyNodeConfig,
  dropNodeKey,
  nodeConfigOf,
  nodeString,
  rec,
  setNodeField,
} from "../node-edit.js";
import { SelectField } from "../pane-controls.js";
import { useKeyedRows, validateInputDraft } from "../validated-draft.js";
import { JsonDraftField, KeyedRowField } from "./fields.js";
import { keyedRowsOf } from "./file-properties.js";
import { PaneSection } from "./properties-pane.js";

// ── The step envelope: config inheritance, input wiring, and context writes ────────────────────────

/** Config keys a first-class editor already owns, so the inheritance region does not double them. */
export function firstClassConfigKeys(type: string): ReadonlySet<string> {
  return type === "prompt" ? new Set(["model"]) : new Set();
}

/**
 * The shared envelope every leaf step carries: the inheritance-aware **config** region, the
 * interpolable **input** object, and the **publish** / **parse** context-write fields. Control blocks
 * carry none of these (`carriesEnvelope`).
 */
export function StepEnvelopeFields({
  file,
  node,
  commit,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
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
 * The config-inheritance region: an inherited key ghosted with its origin and an **Override**; an
 * overridden key solid with a revert; a local key solid. `type` edits in the kind-fields region.
 */
export function ConfigRegion({
  file,
  node,
  commit,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
  const config = nodeConfigOf(node);
  // A value edit passes its identity so a keystroke run folds to one undo entry; a discrete write
  // (Override/Revert/×/add-key) passes none, so it is its own entry.
  const write = (next: ConfigObject | undefined, key?: EditKey): void =>
    commit(applyNodeConfig(node, next), key);
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
 * The shared config editor behind both the step region and the file's own config: `parentConfig` is the
 * inheritance source (`undefined` for the file, whose config *is* the root), and `scopeId` scopes each
 * value's identity so two owners' same-named keys never fold their undo runs together.
 */
export function ConfigEditor({
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
            <ConfigRowField
              key={row.key}
              row={row}
              config={config}
              nodeId={scopeId}
              write={write}
            />
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

/** One config row, rendered by origin: inherited (ghosted + Override), overridden (revert), or local. */
export function ConfigRowField({
  row,
  config,
  nodeId,
  write,
}: {
  row: ConfigRow;
  config: ConfigObject | undefined;
  /** The owning node's id — scopes the value's identity so two nodes' same-named keys never fold. */
  nodeId: string;
  write: EditCommit<ConfigObject | undefined>;
}): JSX.Element {
  if (row.origin === "inherited") {
    return (
      <div className="pane-field pane-config-row" data-origin="inherited">
        <span className="pane-label">{row.key}</span>
        <span className="pane-config-eq" aria-hidden="true">
          =
        </span>
        <div className="pane-config-inherited">
          <code className="pane-config-value pane-ghost">{renderConfigValue(row.value)}</code>
          <button
            type="button"
            className="pane-btn"
            onClick={() => write(setConfigKey(config, row.key, row.value))}
          >
            Override
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-field pane-config-row" data-origin={row.origin}>
      <span className="pane-label">{row.key}</span>
      <span className="pane-config-eq" aria-hidden="true">
        =
      </span>
      <div className="pane-config-local">
        <ConfigValueControl
          value={row.value}
          onChange={(v) =>
            write(setConfigKey(config, row.key, v), editKey(nodeId, "config", row.key))
          }
          label={row.key}
        />
        {row.origin === "overridden" ? (
          <button
            type="button"
            className="pane-btn"
            onClick={() => write(dropConfigKey(config, row.key))}
          >
            Revert
          </button>
        ) : (
          <button
            type="button"
            className="pane-btn"
            aria-label={`Remove ${row.key}`}
            onClick={() => write(dropConfigKey(config, row.key))}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The interpolable **input** object: a live-validated JSON textarea whose `${…}` placeholders reference
 * `config.` / `context.` dot-paths — the roots a step may read before it runs (`STEP_ROOTS`; its own
 * `output` does not exist yet). An unclosed or ill-typed placeholder is reported and never committed.
 */
export function InputEditor({
  node,
  commit,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
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
 * The context-**write** fields: `publish` (a `key → ${…}` map over `config.`/`context.`/`output.`) and
 * `parse`, both pane fields on the step. A publish conflict surfaces separately, as a canvas node marker
 * (projected by `problems.ts`).
 */
export function PublishParseFields({
  node,
  commit,
}: {
  node: WorkflowNode;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
  const parse = nodeString(node, "parse");

  // Keyed rows: it commits only when every value's interpolation is valid, an empty map drops the
  // `publish` key, and a row edit folds to one undo entry scoped by node.
  const { rows, setRow, addRow, removeRow } = useKeyedRows(
    () => keyedRowsOf(rec(node).publish),
    PUBLISH_ROOTS,
    editKey(node.id, "publish"),
    (map, key) =>
      commit(
        Object.keys(map).length === 0
          ? dropNodeKey(node, "publish")
          : ({ ...node, publish: map } as WorkflowNode),
        key,
      ),
  );

  return (
    <PaneSection key={node.id} title="context writes">
      {rows.length > 0 ? (
        // One shared grid so every row's `=` sits in the same column, aligned down the list (§ Config).
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <KeyedRowField
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; the undo fold keys by index.
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
        onChange={(v) =>
          commit(v === "(none)" ? dropNodeKey(node, "parse") : setNodeField(node, "parse", v))
        }
      />
    </PaneSection>
  );
}
