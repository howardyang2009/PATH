import { useEffect, useState } from "react";
import type { LeaseState } from "./lease-client.js";
import type { SaveState } from "./use-open-file.js";

/**
 * The top-bar editing controls (#371): the Save button plus the two edit-lease affordances the lease
 * client raises. Save writes the active buffer through `PUT /v0/workflows` under its `If-Match`; a `412`
 * stale-write conflict is shown, not swallowed. The lease affordances are an acquire `409` (someone else
 * holds the file: a countdown and a **confirmation-gated** takeover) and a heartbeat `409` (the lease was
 * lost mid-edit: a warning and a re-acquire). Both leave the buffer intact — the lease is politeness, the
 * `If-Match` precondition is what actually guards the bytes (ADR 0017).
 */
export function EditingToolbar({
  saveState,
  dirty,
  onSave,
  onReload,
  lease,
  onTakeover,
  onReacquire,
}: {
  saveState: SaveState;
  /** Does the active buffer have unsaved edits (or id-stamps)? Gates the Save button and its label. */
  dirty: boolean;
  onSave: () => void;
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
      {/* Disabled in `conflict`: re-sending the same stale ETag would only 412 again — the author must
          reload first. Otherwise enabled only for a dirty buffer. */}
      <button type="button" className="save-btn" onClick={onSave} disabled={saving || conflict || !dirty}>
        {saving ? "Saving…" : "Save"}
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
