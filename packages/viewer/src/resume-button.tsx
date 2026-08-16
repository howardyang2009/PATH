import type { PathApiClient } from "@path/client-core";
import { useState } from "react";
import { errorMessage } from "./load-state.js";

export interface ResumeButtonProps {
  client: PathApiClient;
  rootRunId: string;
  /** Handed the successor's fresh root run id so the app can switch to watching it (same transition as a launch). */
  onResumed: (successorRootRunId: string) => void;
}

type Phase = "idle" | "sending";

/**
 * Resume a `cancelled`/`failed` root run as a successor (server-api-v0.md §4.3), the console's second
 * write verb after cancel (#56). One click, unlike cancel's two-step arm: resuming is a deliberate
 * recovery action rather than a destructive one, and the accidental-click cost cancel guards against
 * is inverted here — a stray resume starts a fresh paid run, but the operator sees it start and can
 * cancel it, whereas a stray cancel destroys unrecoverable work with no undo.
 *
 * On success the parent switches to watching the successor (a fresh `running` root), so this button
 * unmounts on its own — the old root's detail pane goes away — and there is no terminal phase to
 * model. `"Resuming…"` is the request being in flight, not a run state; the real status arrives over
 * SSE on the successor the app is now watching.
 */
export function ResumeButton({ client, rootRunId, onResumed }: ResumeButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const send = (): void => {
    setError(null);
    setPhase("sending");
    client.resumeRun(rootRunId).then(
      // The app re-selects the successor, which unmounts this component — so no setState here, and
      // no post-unmount update to guard against.
      (res) => onResumed(res.root_run_id),
      (thrown: unknown) => {
        setPhase("idle");
        setError(errorMessage(thrown));
      },
    );
  };

  return (
    <span className="resume-slot">
      <button
        type="button"
        className="resume-button"
        data-testid="resume-button"
        disabled={phase === "sending"}
        onClick={send}
      >
        {phase === "sending" ? "Resuming…" : "Resume run"}
      </button>
      {error !== null && (
        <p className="pane-note pane-error resume-error" role="alert">
          {error}
        </p>
      )}
    </span>
  );
}
