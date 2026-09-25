import { useEffect, useState } from "react";
import type { LeaseState } from "./lease-client.js";
import { templateSuffix } from "./session-reducer.js";
import type { EditMode, SaveState, TemplateSource } from "./use-open-file.js";

const MODES: readonly { key: EditMode; label: string }[] = [
  { key: "workflow", label: "Workflow" },
  { key: "template", label: "Template" },
];

/**
 * Template mode's file name, centred in the top bar (#580): the opened template source, whose Save writes
 * back to it, or — for a new template not saved yet (`template` `null`) — a note that it has no file yet.
 * A shipped template is read-only: its write-back is the API's 403, and Save as… forks it.
 */
export function TemplateFileName({ template }: { template: TemplateSource | null }): JSX.Element {
  if (!template) {
    return <span className="author-mode-tag">New template (not saved)</span>;
  }
  return (
    <span className="author-mode-tag" data-testid="author-mode" title="Save writes back to this template">
      <code>{template.name}{templateSuffix(template.kind)}</code>
      {template.readOnly ? " (shipped, read-only)" : null}
    </span>
  );
}

/**
 * The top-bar editing controls (#371). The **Workflow | Template** switch ({@link ModeSwitch}) picks the
 * edit mode, and New and Open… act in that mode (a workflow, or a template). Then Undo, Redo, Save and
 * Save as…. Save writes the active buffer under its `If-Match`; a `412` stale-write
 * conflict is shown, not swallowed. The lease affordances are an acquire `409` (someone else holds the
 * file: a countdown and a **confirmation-gated** takeover) and a heartbeat `409` (the lease was lost
 * mid-edit: a warning and a re-acquire). Both leave the buffer intact — the lease is politeness, the
 * `If-Match` precondition is what actually guards the bytes (ADR 0017).
 */
/** The **Workflow | Template** edit-mode switch: a segmented radio group in the top bar, after the brand. */
export function ModeSwitch({ mode, onSwitch }: { mode: EditMode; onSwitch: (mode: EditMode) => void }): JSX.Element {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Edit mode">
      {MODES.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="radio"
          className="mode-switch-option"
          aria-checked={mode === key}
          onClick={() => mode !== key && onSwitch(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function EditingToolbar({
  onNew,
  onOpen,
  canSaveAs,
  saveState,
  dirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onSaveAs,
  onReload,
  lease,
  onTakeover,
  onReacquire,
}: {
  /** Start a new workflow or a new template, by mode. */
  onNew: () => void;
  /** Open the pick-an-existing dialog for the mode: a workflow (#254) or a template. */
  onOpen: () => void;
  /** Is a saved file open on the canvas? Save as… needs one: a new, never-saved buffer has only Save. */
  canSaveAs: boolean;
  saveState: SaveState;
  /** Does the active buffer have unsaved edits (or id-stamps)? Gates the Save button and its label. */
  dirty: boolean;
  /** Has the active frame an edit to undo (#389)? Gates the Undo button. */
  canUndo: boolean;
  /** Has the active frame an undo to redo (#389)? Gates the Redo button. */
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  /** Save a copy under a new name: a new workflow file in workflow mode, a new template in template mode. */
  onSaveAs: () => void;
  /** Re-fetch the active file from disk — the stale-write conflict recovery. */
  onReload: () => void;
  /** The active file's lease state, or `undefined` before it is known. */
  lease: LeaseState | undefined;
  onTakeover: () => void;
  onReacquire: () => void;
}): JSX.Element {
  const saving = saveState.phase === "saving";
  const conflict = saveState.phase === "conflict";
  return (
    <div className="editing-toolbar">
      {/* New and Open… discard the current stack, so they sit apart from the edit controls. */}
      <button type="button" className="toolbar-btn" onClick={onNew}>
        New
      </button>
      <button type="button" className="toolbar-btn" onClick={onOpen}>
        Open…
      </button>
      {/* Undo/redo drive the active frame's own per-file stack (#389). Both survive a save — the save
          moves the baseline, not the history — so an undo past the save-point re-dirties the buffer. */}
      <button type="button" className="toolbar-btn" aria-label="Undo" onClick={onUndo} disabled={!canUndo}>
        ↶ Undo
      </button>
      <button type="button" className="toolbar-btn" aria-label="Redo" onClick={onRedo} disabled={!canRedo}>
        ↷ Redo
      </button>
      {/* Disabled in `conflict`: re-sending the same stale ETag would only 412 again — the author must
          reload first. Otherwise enabled only for a dirty buffer. */}
      <button type="button" className="save-btn" onClick={onSave} disabled={saving || conflict || !dirty}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="toolbar-btn" onClick={onSaveAs} disabled={saving || !canSaveAs}>
        Save as…
      </button>
      {saveState.phase === "saved" ? (
        <span className="save-status" role="status">
          Saved.
        </span>
      ) : null}
      {conflict ? (
        <div className="save-conflict" role="alert">
          <span>
            This file changed on disk since you opened it. Your save was refused to avoid overwriting that change. Reload to get
            the latest, then re-apply your edits.
          </span>
          <button type="button" onClick={onReload}>
            Reload file
          </button>
        </div>
      ) : null}
      {saveState.phase === "error" ? (
        <div className="save-error" role="alert">
          Could not save: {saveState.message}
        </div>
      ) : null}
      <LeaseBanner lease={lease} onTakeover={onTakeover} onReacquire={onReacquire} />
    </div>
  );
}

/** The lease banner for the active file: a held-by-other takeover offer, or a lost-lease re-acquire. */
function LeaseBanner({
  lease,
  onTakeover,
  onReacquire,
}: {
  lease: LeaseState | undefined;
  onTakeover: () => void;
  onReacquire: () => void;
}): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);

  if (lease?.phase === "held-by-other") {
    return (
      <div className="lease-banner lease-held-by-other" role="alert">
        <span>
          Another session is editing this file{lease.expiresAt ? <> — its lease expires in <Countdown expiresAt={lease.expiresAt} /></> : null}.
        </span>
        {confirming ? (
          <>
            <span className="lease-confirm-q">Take over anyway?</span>
            <button type="button" onClick={onTakeover}>
              Confirm takeover
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Take over
          </button>
        )}
      </div>
    );
  }

  if (lease?.phase === "lost") {
    return (
      <div className="lease-banner lease-lost" role="alert">
        <span>Editing lease lost. Another session may have taken over, or your lease expired.</span>
        <button type="button" onClick={onReacquire}>
          Re-acquire
        </button>
      </div>
    );
  }

  if (lease?.phase === "error") {
    return (
      <div className="lease-banner lease-error" role="alert">
        Could not acquire the editing lease: {lease.message}
      </div>
    );
  }

  return null;
}

/** A live "in Ns" countdown to a wall-clock `expiresAt`, ticking each second; never below zero. */
function Countdown({ expiresAt }: { expiresAt: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return <span className="lease-countdown">{seconds}s</span>;
}
