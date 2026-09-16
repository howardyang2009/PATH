import type { AwaitingNode, PathApiClient } from "@path/client-core";
import { useEffect, useRef } from "react";
import { AssigneeChip } from "./assignee-chip.js";
import { CompleteForm } from "./complete-form.js";
import { StatusPill } from "./status-pill.js";

export interface CompleteSlideOverProps {
  open: boolean;
  onClose: () => void;
  client: PathApiClient;
  /** The awaiting leaf's run id. */
  stepRunId: string;
  /** The step's display name, for the panel header. */
  stepName: string;
  /** The node's fields — the description callout, the assignee chip, and the form's `outputSchema`. */
  awaitingNode: AwaitingNode;
  /** Called on a `202` — the caller closes the panel; the root's SSE stream drives the continuation. */
  onCompleted: () => void;
}

/**
 * The Complete form as a right-edge slide-over (issue #470 verdict, variant B): not a docked inbox and
 * not a modal. It repeats the step's `description` and `assignee` for context above the schema-driven
 * form, so the person completes the activity without losing the instructions. `Escape` and a click on
 * the scrim both close it; focus moves into the panel on open.
 */
export function CompleteSlideOver({ open, onClose, client, stepRunId, stepName, awaitingNode, onCompleted }: CompleteSlideOverProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    // Move focus into the panel so keyboard users land inside it, and wire Escape to close.
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="slide-over-scrim" data-testid="complete-scrim" onClick={onClose} />
      <aside
        className="slide-over"
        role="dialog"
        aria-modal="true"
        aria-label={`Complete ${stepName}`}
        tabIndex={-1}
        ref={panelRef}
        data-testid="complete-slide-over"
      >
        <header className="slide-over-head">
          <span className="node-name">{stepName}</span>
          <StatusPill status="awaiting" />
          <button type="button" className="slide-over-close" aria-label="Close" data-testid="complete-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="slide-over-body">
          {awaitingNode.assignee !== null && <AssigneeChip assignee={awaitingNode.assignee} />}
          {awaitingNode.description !== null && (
            <p className="awaiting-callout" data-testid="awaiting-description">
              {awaitingNode.description}
            </p>
          )}
          <CompleteForm
            client={client}
            stepRunId={stepRunId}
            outputSchema={awaitingNode.outputSchema}
            onCompleted={onCompleted}
          />
        </div>
      </aside>
    </>
  );
}
