import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EditorChrome } from "./editor-chrome.js";
import type { LeaseState } from "./lease-client.js";
import { canonicalSerialize } from "./serialize.js";
import {
  type Frame,
  frameHasUnsavedWork,
  openedResultOf,
  TEMPLATE_SUFFIX,
} from "./session-reducer.js";
import type { EditMode, SaveState, TemplateSource } from "./use-open-file.js";

const MODES: readonly { key: EditMode; label: string }[] = [
  { key: "workflow", label: "Workflow" },
  { key: "template", label: "Template" },
];

/**
 * Workflow mode's file name, centred in the top bar: the opened workflow's path, or — for a new
 * workflow not saved yet (`path` `undefined`) — a note that it has no file yet. {@link FileStatus}
 * replaces it while a status shows.
 */
export function WorkflowFileName({ path }: { path: string | undefined }): JSX.Element {
  if (path === undefined) {
    return <span className="author-mode-tag">New workflow (not saved)</span>;
  }
  return (
    <span
      className="author-mode-tag"
      data-testid="workflow-file-name"
      title="Save writes back to this file"
    >
      <code>{path}</code>
    </span>
  );
}

/**
 * Template mode's file name, centred in the top bar: the opened template source, whose Save writes
 * back to it, or — for a new template not saved yet (`template` `null`) — a note that it has no
 * file yet. A shipped template is read-only: its write-back is the API's 403, and Save as… forks
 * it. {@link FileStatus} replaces it while a status shows.
 */
export function TemplateFileName({ template }: { template: TemplateSource | null }): JSX.Element {
  if (!template) {
    return <span className="author-mode-tag">New template (not saved)</span>;
  }
  return (
    <span
      className="author-mode-tag"
      data-testid="author-mode"
      title="Save writes back to this template"
    >
      <code>
        {template.name}
        {TEMPLATE_SUFFIX}
      </code>
      {template.readOnly ? ` (${template.readOnly}, read-only)` : null}
    </span>
  );
}

/**
 * The active file's save status, centred in the top bar in place of the file name (`fileName`,
 * shown only while no status shows), so the toolbar's buttons never shift when it changes. A failed
 * save wins: a `412` stale-write conflict (with its Reload, the recovery) or any other save or
 * delete error. Else "Unsaved edits" for a buffer with unsaved work, "Saved" after a save lands,
 * "Saved as template" after a workflow's Save as template, "Deleting…" while a Delete runs, or "Deleted" once a Delete removed the
 * file. An id-less file (ids stamped on import, ADR 0015) or a non-canonical one opens dirty with
 * no edit, so that reason is named instead. An untouched New buffer has no unsaved work, so it shows nothing.
 */
export function FileStatus({
  frame,
  saveState,
  onReload,
  fileName,
}: {
  frame: Frame | undefined;
  saveState: SaveState;
  /** Re-fetch the active file from disk — the stale-write conflict recovery. */
  onReload: () => void;
  /** The active file's name, shown when there is no status to show. */
  fileName?: ReactNode;
}): JSX.Element | null {
  if (saveState.phase === "conflict") {
    return (
      <span
        className="file-status file-status-failed"
        role="alert"
        title="This file changed on disk since you opened it. Your save was refused to avoid overwriting that change. Reload to get the latest, then re-apply your edits."
      >
        Save refused: this file changed on disk since you opened it
        <button type="button" className="file-status-action" onClick={onReload}>
          Reload file
        </button>
      </span>
    );
  }
  if (saveState.phase === "error" || saveState.phase === "delete-error") {
    const verb = saveState.phase === "error" ? "save" : "delete";
    return (
      <span className="file-status file-status-failed" role="alert" title={saveState.message}>
        Could not {verb}: {saveState.message}
      </span>
    );
  }
  if (saveState.phase === "saved-as-template") {
    return (
      <span className="file-status file-status-saved" role="status">
        Saved as template "{saveState.name}"
      </span>
    );
  }
  if (saveState.phase === "deleting") {
    return (
      <span className="file-status" role="status">
        Deleting…
      </span>
    );
  }
  if (saveState.phase === "deleted") {
    return (
      <span className="file-status file-status-saved" role="status">
        Deleted
      </span>
    );
  }
  const opened = openedResultOf(frame);
  if (frame && opened && frameHasUnsavedWork(frame)) {
    // `pristine`: the buffer still equals its bytes at the last save-point, so no edit dirties it:
    // only the id stamp or a non-canonical source (key order, spacing) that Save will rewrite.
    const pristine = canonicalSerialize(opened.file) === frame.openedBytes;
    return (
      <span className="file-status file-status-unsaved" role="status">
        {!pristine
          ? "Unsaved edits"
          : opened.idsStamped
            ? "Ids stamped on import — unsaved (ADR 0015)"
            : "Non-canonical file: Save will reformat it"}
      </span>
    );
  }
  if (saveState.phase !== "saved") return <>{fileName ?? null}</>;
  return (
    <span className="file-status file-status-saved" role="status">
      Saved
    </span>
  );
}

/**
 *
 * The top-bar editing controls. The **Workflow | Template** switch ({@link ModeSwitch}) picks the
 * edit mode, and the File menu's New, Open…, Save as…, Download and Delete act in that mode (a
 * workflow, or a template). Then Undo, Redo and Save (also ⌘S / Ctrl+S). Save writes the active buffer under its `If-Match`; a `412` stale-write
 * conflict is shown ({@link FileStatus}, centred in the top bar), not swallowed. The lease
 * affordances are an acquire `409` (someone else holds the
 * file: a countdown and a **confirmation-gated** takeover) and a heartbeat `409` (the lease was
 * lost mid-edit: a warning and a re-acquire). Both leave the buffer intact — the lease is
 * politeness, the `If-Match` precondition is what actually guards the bytes (ADR 0017).
 *
 */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The editing shortcuts as the platform names them. */
const SAVE_SHORTCUT = IS_MAC ? "⌘S" : "Ctrl+S";
const UNDO_SHORTCUT = IS_MAC ? "⌘Z" : "Ctrl+Z";
const REDO_SHORTCUT = IS_MAC ? "⇧⌘Z" : "Ctrl+Y";

/** The **Workflow | Template** edit-mode switch: a segmented radio group in the top bar, after the
 * brand. */
export function ModeSwitch({
  mode,
  onSwitch,
}: {
  mode: EditMode;
  onSwitch: (mode: EditMode) => void;
}): JSX.Element {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Edit mode">
      {MODES.map(({ key, label }) => (
        <label key={key} className="mode-switch-option">
          <input
            type="radio"
            name="edit-mode"
            value={key}
            checked={mode === key}
            aria-label={label}
            onChange={() => mode !== key && onSwitch(key)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

export function EditingToolbar({
  chrome,
  onNew,
  onOpen,
  onUndo,
  onRedo,
  onSave,
  onSaveAs,
  onDelete,
  onDownload,
  onTakeover,
  onReacquire,
}: {
  /** Which document actions are live, and what Save shows (`editorChrome`). */
  chrome: EditorChrome;
  /** Start a new workflow or a new template, by mode. */
  onNew: () => void;
  /** Open the pick-an-existing dialog for the mode: a workflow or a template. */
  onOpen: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  /** Save a copy under a new name: a new workflow file in workflow mode, a new template in template
   * mode. */
  onSaveAs: () => void;
  /** Delete the open workflow or template from disk, after the author confirms. */
  onDelete: () => void;
  /** Download the active frame's saved file: a workflow (zipped with the files it refs) or a
   * template. */
  onDownload: () => void;
  onTakeover: () => void;
  onReacquire: () => void;
}): JSX.Element {
  return (
    <div className="editing-toolbar">
      {/* The rare whole-file actions sit behind File: New and Open… discard the current stack, and
          Delete removes the file from disk. */}
      <FileMenu
        groups={[
          [
            { label: "New", onSelect: onNew },
            { label: "Open…", onSelect: onOpen },
          ],
          [
            { label: "Save as…", onSelect: onSaveAs, disabled: chrome.busy || !chrome.saveAs },
            {
              label: "Download",
              onSelect: onDownload,
              disabled: !chrome.download,
              title: chrome.download ? "Download the saved file" : "Save first",
            },
          ],
          [
            {
              label: "Delete",
              onSelect: onDelete,
              disabled: chrome.busy || !chrome.remove,
              title: chrome.readOnlyTitle,
              danger: true,
            },
          ],
        ]}
      />
      {/* Undo/redo drive the active frame's own per-file stack. Both survive a save — the save
          moves the baseline, not the history — so an undo past the save-point re-dirties the
          buffer. */}
      <button
        type="button"
        className="toolbar-btn"
        aria-label="Undo"
        onClick={onUndo}
        disabled={!chrome.undo}
        title={`Undo (${UNDO_SHORTCUT})`}
      >
        ↶ Undo
      </button>
      <button
        type="button"
        className="toolbar-btn"
        aria-label="Redo"
        onClick={onRedo}
        disabled={!chrome.redo}
        title={`Redo (${REDO_SHORTCUT})`}
      >
        ↷ Redo
      </button>
      {/* Disabled in `conflict`: re-sending the same stale ETag would only 412 again — the author
          must reload first. Otherwise enabled only for a dirty buffer. */}
      <button
        type="button"
        className="save-btn"
        onClick={onSave}
        disabled={!chrome.save}
        title={chrome.readOnlyTitle ?? `Save (${SAVE_SHORTCUT})`}
      >
        {chrome.saveLabel}
      </button>
      <LeaseBanner lease={chrome.lease} onTakeover={onTakeover} onReacquire={onReacquire} />
    </div>
  );
}

type FileMenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
};

/** The File menu's enabled items, in order: the arrow keys skip a disabled one. */
function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []).filter(
    (item) => !item.disabled,
  );
}

/** The File drop-down: a menu button whose items take arrow-key focus. Escape closes it and returns
 * focus to the button; a click outside or a Tab away closes it. A disabled item stays visible, and a
 * separator splits the groups. */
function FileMenu({ groups }: { groups: readonly (readonly FileMenuItem[])[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    enabledItems(menuRef.current)[0]?.focus();
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent): void => {
    const enabled = enabledItems(menuRef.current);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (index: number): void =>
      enabled[(index + enabled.length) % enabled.length]?.focus();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(at - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="file-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="toolbar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        File
        <span className="file-menu-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div
          className="file-menu-list"
          role="menu"
          aria-label="File"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0]?.label}>
              {index > 0 ? <hr className="file-menu-separator" /> : null}
              {group.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={
                    item.danger ? "file-menu-item file-menu-item-danger" : "file-menu-item"
                  }
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The lease banner for the active file: a held-by-other takeover offer, or a lost-lease
 * re-acquire. */
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
          Another session is editing this file
          {lease.expiresAt ? (
            <>
              {" "}
              — its lease expires in <Countdown expiresAt={lease.expiresAt} />
            </>
          ) : null}
          .
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
