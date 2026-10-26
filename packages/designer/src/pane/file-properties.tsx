import type { WireStepPlugin } from "@path/client-core";
import { type ConfigObject, ROOTS, type WorkflowFile } from "@path/schema";
import { WorkerDefaultsEditor, workerDefaultCandidates } from "@path/viewer";
import { useTranslations } from "use-intl";
import { type EditCommit, type EditKey, editKey } from "../edit-key.js";
import { withOptionalKey } from "../edit-target.js";
import { referenceablePaths } from "../interp-suggest.js";
import { fillPlaceholderOnTab, ReadOnlyRow, TextField } from "../pane-controls.js";
import { type KeyedRow, useKeyedRows, validateFileInputDraft } from "../validated-draft.js";
import { ConfigEditor } from "./config-region.js";
import { JsonDraftField, KeyedRowField, PaneSection } from "./fields.js";
import { ReferenceList } from "./node-properties.js";

// ── The file's own properties ────────────────────────────────────────────────────────────────────

export function FileProperties({
  file,
  plugins,
  applyEdit,
}: {
  file: WorkflowFile;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element {
  const t = useTranslations();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegated Tab handling for wrapped inputs.
    <div className="pane" onKeyDown={fillPlaceholderOnTab}>
      <p className="pane-explain">{t("designer.pane.fileExplain")}</p>
      <hr className="pane-divider" />
      {/* A keystroke run in one field folds to one undo entry; a different field's identity breaks
        the run. */}
      <TextField
        label="name"
        value={file.name}
        onChange={(name) => applyEdit({ ...file, name }, editKey(file.id, "name"))}
      />
      <ReadOnlyRow label="id" value={file.id} />
      <ReadOnlyRow label="format" value={file.format} />
      <hr className="pane-divider" />
      <FileConfigRegion key={`file-config-${file.id}`} file={file} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileInputRegion file={file} applyEdit={applyEdit} />
      <hr className="pane-divider" />
      <FileWorkerDefaultsRegion
        key={`file-worker-defaults-${file.id}`}
        file={file}
        plugins={plugins}
        applyEdit={applyEdit}
      />
      <hr className="pane-divider" />
      <FileOutputRegion file={file} applyEdit={applyEdit} />
      <FileReferenceSection file={file} />
    </div>
  );
}

/**
 * The file-level **Reference** list, the counterpart of a node's `ReferenceSection`. The file's
 * only interpolable field is its own `output` map, whose roots always contribute bare prefixes, so
 * the list is never empty.
 */
export function FileReferenceSection({ file }: { file: WorkflowFile }): JSX.Element | null {
  return (
    <ReferenceList ownerId={file.id} paths={referenceablePaths(file, [...ROOTS.fileOutput])} />
  );
}

/**
 * The **file worker-default** editor: the shared `WorkerDefaultsEditor` bound to the file's
 * `worker_defaults`, a plain `{ <type>: <name> }` map read and written by constrained dropdowns, so
 * an invalid pair (the hard load error ADR 0044 defines) cannot be authored here. An empty map
 * drops the key. The launch tier has no editor — it is supplied at launch (ADR 0044) — and a
 * registry of single-worker types renders no section at all.
 */
export function FileWorkerDefaultsRegion({
  file,
  plugins,
  applyEdit,
}: {
  file: WorkflowFile;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element | null {
  const t = useTranslations();
  // No multi-worker type in the registry → no selection to make. Hide the section entirely.
  if (workerDefaultCandidates(plugins).length === 0) return null;

  const write = (map: { [type: string]: string }): void => {
    // An empty table omits the key rather than writing `worker_defaults: {}` (`withOptionalKey`).
    applyEdit(
      withOptionalKey(file, "worker_defaults", Object.keys(map).length === 0 ? undefined : map),
    );
  };

  return (
    <PaneSection title={t("designer.pane.workerDefaults")}>
      <WorkerDefaultsEditor
        plugins={plugins}
        value={file.worker_defaults ?? {}}
        onChange={write}
        hint={t("designer.pane.workerDefaultsHint")}
      />
    </PaneSection>
  );
}

/**
 * A `key → value` map (a file's `output`, a step's `publish`) read back as editor rows, each value
 * in its string form.
 */
export function keyedRowsOf(map: unknown): KeyedRow[] {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/**
 * The workflow's own **output** object (docs/format/workflow-format.md §6.4): a `key → ${…}` map
 * evaluated at success into the value a parent's `publish` reads back across a `workflow`-ref.
 * Values interpolate `config.`/`context.` only and are held as a draft committed only when valid,
 * so an ill-typed `${…}` never reaches the file; non-string values are shown JSON-stringified.
 */
export function FileOutputRegion({
  file,
  applyEdit,
}: {
  file: WorkflowFile;
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element {
  const t = useTranslations();
  // Keyed rows: an empty map drops the whole `output` key; a row edit folds to one undo entry.
  const { rows, setRow, addRow, removeRow } = useKeyedRows(
    () => keyedRowsOf((file as { output?: unknown }).output),
    ROOTS.fileOutput,
    editKey(file.id, "output"),
    (map, key) => {
      // An empty map omits the `output` key rather than writing `output: {}` (`withOptionalKey`).
      applyEdit(
        withOptionalKey(file, "output", Object.keys(map).length === 0 ? undefined : map),
        key,
      );
    },
  );

  return (
    <PaneSection title="output">
      <p className="pane-hint">{t("designer.pane.output.hint")}</p>
      {rows.length > 0 ? (
        <div className="pane-publish-grid">
          {rows.map((row, index) => (
            <KeyedRowField
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; the undo fold keys by index.
              key={index}
              row={row}
              roots={ROOTS.fileOutput}
              keyLabel={t("designer.pane.output.key")}
              valueLabel={t("designer.pane.output.value")}
              removeLabel={t("designer.pane.output.remove")}
              keyPlaceholder={t("designer.pane.output.keyPlaceholder")}
              // Mirrors the key typed — `${context.<key>}` — landing the step context value of that
              // name.
              valuePlaceholder={(r) => `\${context.${r.key === "" ? "key" : r.key}}`}
              onChange={(r) => setRow(index, r)}
              onRemove={() => removeRow(index)}
            />
          ))}
        </div>
      ) : null}
      <button type="button" className="pane-btn" onClick={addRow}>
        {t("designer.pane.output.add")}
      </button>
    </PaneSection>
  );
}

/**
 * The file's own **config**: the workflow-level defaults every step inherits. There is no parent to
 * inherit from — the file's config *is* the root — so every key renders local. A cleared config
 * drops the whole `config` field.
 */
export function FileConfigRegion({
  file,
  applyEdit,
}: {
  file: WorkflowFile;
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element {
  const t = useTranslations();
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
      emptyHint={t("designer.pane.config.emptyFile")}
    />
  );
}

/**
 * The file's own **input** seed: the default root context seed, sent at launch when the operator
 * supplies no override. Unlike a step's `input` nothing interpolates here, so only plain JSON is
 * accepted; an empty box or `{}` drops the key, and a blank box reads back as `{}`.
 */
export function FileInputRegion({
  file,
  applyEdit,
}: {
  file: WorkflowFile;
  applyEdit: EditCommit<WorkflowFile>;
}): JSX.Element {
  const t = useTranslations();
  const identity = editKey(file.id, "input");
  return (
    <PaneSection title="input">
      <JsonDraftField
        id={`file-input-${file.id}`}
        label={t("designer.pane.fileInputLabel")}
        rows={5}
        initial={() => (file.input === undefined ? "{}" : JSON.stringify(file.input, null, 2))}
        validate={(text) => validateFileInputDraft(file, text)}
        identity={identity}
        commit={(next) => applyEdit(next, identity)}
      />
    </PaneSection>
  );
}
