import type { PathApiClient } from "@path/client-core";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./load-state.js";

/** How long an armed "Confirm cancel?" waits before disarming itself (issue #56). */
export const ARM_TIMEOUT_MS = 3000;

export interface CancelButtonProps {
  client: PathApiClient;
  rootRunId: string;
}

type Phase = "idle" | "armed" | "sending";

/**
 * The console's first write verb (#56, decision record #52): an inline two-step confirm, not a
 * modal and not `window.confirm` — the first click arms, a second within {@link ARM_TIMEOUT_MS}
 * sends, and an idle arm disarms itself so a stray click cannot fire a cancel on its own. There is
 * no retry or resume in PATH (mvp spec §1), so a single click destroying minutes of paid,
 * unrecoverable LLM work is the failure this button exists to prevent.
 *
 * "Cancelling…" is local state only: the server models no `cancelling` status (ticket 3), and the
 * truth still arrives over SSE (`run-cancelled` folded in by the view-model) — this component never
 * claims the run has stopped, only that the request was sent. A reload during the unwind window
 * shows an armed-and-ready button again, which is harmless because a repeat cancel answers 202.
 *
 * The parent mounts this only while the root run is pending/running (map #40's one exception to
 * read-only) and unmounts it the moment the status folds in as terminal, so there is no terminal
 * phase to model here.
 */
export function CancelButton({ client, rootRunId }: CancelButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const disarm = (): void => {
    clearTimer();
    setPhase("idle");
  };

  const arm = (): void => {
    setError(null);
    setPhase("armed");
    timer.current = setTimeout(disarm, ARM_TIMEOUT_MS);
  };

  const send = (): void => {
    clearTimer();
    setPhase("sending");
    client.cancelRun(rootRunId).catch((thrown: unknown) => {
      setPhase("idle");
      setError(errorMessage(thrown));
    });
  };

  return (
    <span className="cancel-slot">
      <button
        type="button"
        className="cancel-button"
        data-testid="cancel-button"
        data-armed={phase === "armed" ? "true" : undefined}
        disabled={phase === "sending"}
        onClick={phase === "armed" ? send : arm}
        onBlur={phase === "armed" ? disarm : undefined}
      >
        {phase === "sending" ? "Cancelling…" : phase === "armed" ? "Confirm cancel?" : "Cancel run"}
      </button>
      {error !== null && (
        <p className="pane-note pane-error cancel-error" role="alert">
          {error}
        </p>
      )}
    </span>
  );
}
