import type { WireStepPlugin } from "@path/client-core";

/**
 * The worker-default editor, shared by the Designer's file `worker_defaults` region and the Viewer's
 * launch form, which authors the launch worker-default. The two *tiers* differ (file-scoped and live
 * versus run-wide and frozen) but not the editing: both pick a type among the registry's multi-worker
 * types and a worker among that type's names, so an invalid `{ type, worker }` pair cannot be authored.
 *
 * Controlled and storage-free: the caller decides what an empty table means (the Designer drops the
 * file key, the launch form omits the wire field) and owns the section's framing.
 */
export interface WorkerDefaultsEditorProps {
  /** The received `GET /v0/step-plugins` registry — the source of both dropdowns' options. */
  plugins: readonly WireStepPlugin[];
  /** The table as it stands, `{ <type>: <worker-name> }`. Empty means unset. */
  value: { [type: string]: string };
  /** Handed the whole next table; the current one is never mutated. */
  onChange: (next: { [type: string]: string }) => void;
  /** One line saying what the table selects and what it does not override. */
  hint: string;
}

/**
 * The registry types a worker-default can select: a single-worker type has nothing to pick, so it is
 * never offered. Exported because a caller that renders its own disclosure needs the same test to
 * decide whether the section exists at all.
 */
export function workerDefaultCandidates(plugins: readonly WireStepPlugin[]): WireStepPlugin[] {
  return plugins.filter((plugin) => plugin.workers.length > 1);
}

export function WorkerDefaultsEditor({
  plugins,
  value,
  onChange,
  hint,
}: WorkerDefaultsEditorProps): JSX.Element | null {
  const candidates = workerDefaultCandidates(plugins);
  // No multi-worker type in the registry → no selection to make. Hide the section entirely.
  if (candidates.length === 0) return null;

  const entries = Object.entries(value);
  const usedTypes = new Set(entries.map(([type]) => type));
  const pluginOf = (type: string): WireStepPlugin | undefined =>
    plugins.find((p) => p.name === type);

  // Retyping a row resets its worker to the new type's default: a worker name is meaningless across
  // types (CONTEXT.md invariant 5).
  const setTypeAt = (oldType: string, newType: string): void => {
    if (newType === oldType) return;
    const plugin = pluginOf(newType);
    const next: { [type: string]: string } = {};
    for (const [type, worker] of entries) {
      next[type === oldType ? newType : type] =
        type === oldType ? (plugin?.default_worker ?? worker) : worker;
    }
    onChange(next);
  };

  const setWorkerAt = (type: string, worker: string): void =>
    onChange({ ...value, [type]: worker });
  const removeAt = (type: string): void =>
    onChange(Object.fromEntries(entries.filter(([entryType]) => entryType !== type)));
  const addRow = (): void => {
    const free = candidates.find((plugin) => !usedTypes.has(plugin.name));
    if (free) onChange({ ...value, [free.name]: free.default_worker });
  };
  const allUsed = candidates.every((plugin) => usedTypes.has(plugin.name));

  return (
    <div className="worker-defaults" data-testid="worker-defaults">
      <p className="worker-defaults-hint">{hint}</p>
      {entries.map(([type, worker]) => {
        const plugin = pluginOf(type);
        const workerOptions = plugin ? plugin.workers : [worker];
        // A type appears once: offer this row's own type plus every candidate no other row uses.
        const typeOptions = [
          type,
          ...candidates
            .map((candidate) => candidate.name)
            .filter((name) => name !== type && !usedTypes.has(name)),
        ];
        return (
          <div key={type} className="worker-default-row">
            <label className="worker-default-field">
              <span className="field-label">type</span>
              <select
                className="field"
                value={type}
                onChange={(event) => setTypeAt(type, event.target.value)}
              >
                {typeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="worker-default-field">
              <span className="field-label">worker</span>
              <select
                className="field"
                value={worker}
                onChange={(event) => setWorkerAt(type, event.target.value)}
              >
                {workerOptions.map((option) => (
                  <option key={option} value={option}>
                    {plugin && option === plugin.default_worker ? `${option} (default)` : option}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="card-action worker-default-remove"
              data-testid={`worker-default-remove-${type}`}
              onClick={() => removeAt(type)}
              aria-label="Remove this worker default"
              title="Remove this worker default"
            >
              ✕
            </button>
          </div>
        );
      })}
      {allUsed ? null : (
        <button
          type="button"
          className="card-action worker-default-add"
          data-testid="worker-default-add"
          onClick={addRow}
        >
          + add worker default
        </button>
      )}
    </div>
  );
}
