import type { AwaitingNode, PathApiClient, RunNodeState } from "@path/client-core";
import { nodeLabel } from "@path/client-core";
import { useState } from "react";
import { AssigneeChip } from "./assignee-chip.js";
import { CompleteSlideOver } from "./complete-slide-over.js";

export interface AwaitingActionsProps {
  client: PathApiClient;
  /** The selected run — always one whose status is `awaiting` (the caller mounts this only then). */
  run: RunNodeState;
  /**
   * The step's `person-activity` node, read from the workflow file by id — the description, assignee,
   * and `outputSchema`. `null` when the file could not resolve the node (a leaf in a nested workflow
   * file, or a node the author retyped mid-wait): the surface degrades to a schema-less submit and
   * says so, rather than inventing a form.
   */
  awaitingNode: AwaitingNode | null;
}

/** The schema-less fallback when the node cannot be read: an empty output the server accepts (or 400s). */
const FALLBACK_NODE: AwaitingNode = { description: null, assignee: null, outputSchema: null };

/**
 * The awaiting step's detail-panel surface (issue #486): the interpolable `description` as a callout,
 * the `assignee` chip, and the **Complete** button that opens the slide-over form. The root run stays
 * `running` while this leaf awaits (ADR 0038), so this is the one place the run is actionable.
 *
 * On completion the slide-over closes; nothing else is needed here, because the Viewer already watches
 * the root's SSE stream — the leaf's `awaiting → succeeded` transition and the run's continuation fold
 * into the live snapshot on their own.
 */
export function AwaitingActions({ client, run, awaitingNode }: AwaitingActionsProps) {
  const [open, setOpen] = useState(false);
  const node = awaitingNode ?? FALLBACK_NODE;
  const stepName = run.nodeName ?? nodeLabel(run.nodeId);

  return (
    <section className="awaiting-actions" data-testid="awaiting-actions" aria-label="Complete awaiting step">
      {node.assignee !== null && <AssigneeChip assignee={node.assignee} />}
      {node.description !== null && (
        <p className="awaiting-callout" data-testid="awaiting-description">
          {node.description}
        </p>
      )}
      {awaitingNode === null && (
        <p className="pane-note" data-testid="awaiting-unresolved">
          This step's form could not be read from the workflow file. Submitting sends an empty output.
        </p>
      )}
      <button type="button" className="launch-submit awaiting-complete-button" data-testid="awaiting-complete-button" onClick={() => setOpen(true)}>
        Complete this activity
      </button>

      <CompleteSlideOver
        open={open}
        onClose={() => setOpen(false)}
        client={client}
        stepRunId={run.runId}
        stepName={stepName}
        awaitingNode={node}
        onCompleted={() => setOpen(false)}
      />
    </section>
  );
}
