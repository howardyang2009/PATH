import type { AwaitingNode, PathApiClient, RunNodeState } from "@path/client-core";
import { AssigneeChip } from "./assignee-chip.js";
import { CompleteForm } from "./complete-form.js";
import { JsonView } from "./json-view.js";

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
  /**
   * The launch config paths the tree recorded as `$secret`-masked (ADR 0046), as dot-paths. Non-empty,
   * the Complete form asks for them again: a continuation recovers the frozen config, and a masked
   * `[secret:<key>]` token cannot run, so the engine refuses before the first step until re-supplied.
   * Read from the tree's launch facts, so it is the same set wherever the awaiting leaf sits.
   */
  launchSecretKeys?: readonly string[];
}

/** The schema-less fallback when the node cannot be read: an empty output the server accepts (or 400s). */
const FALLBACK_NODE: AwaitingNode = { description: null, assignee: null, outputSchema: null };

/**
 * The awaiting step's Complete surface, **inline** in the node I/O/C/E panel (issue #486). It is no
 * longer a slide-over: the `description` callout, the `assignee` chip, the step's `outputSchema` (shown
 * even when empty, so the person sees the shape their output is checked against), and the Complete form
 * itself all live in the one panel. The root run stays `running` while this leaf awaits (ADR 0038), so
 * this is the one place the run is actionable.
 *
 * On completion nothing is torn down here: the Viewer already watches the root's SSE stream, so the
 * leaf's `awaiting → succeeded` transition folds into the live snapshot, the run's status leaves
 * `awaiting`, and the panel stops mounting this surface on its own.
 */
export function AwaitingActions({
  client,
  run,
  awaitingNode,
  launchSecretKeys,
}: AwaitingActionsProps) {
  const node = awaitingNode ?? FALLBACK_NODE;

  return (
    <section
      className="awaiting-actions"
      data-testid="awaiting-actions"
      aria-label="Complete awaiting step"
    >
      {node.assignee !== null && <AssigneeChip assignee={node.assignee} />}
      {node.description !== null && (
        <p className="awaiting-callout" data-testid="awaiting-description">
          {node.description}
        </p>
      )}
      {awaitingNode === null && (
        <p className="pane-note" data-testid="awaiting-unresolved">
          This step's form could not be read from the workflow file. Submitting sends an empty
          output.
        </p>
      )}

      <section
        className="io-block"
        data-testid="awaiting-output-schema"
        aria-labelledby="awaiting-output-schema-title"
      >
        <h3 className="io-title" id="awaiting-output-schema-title">
          Output schema
        </h3>
        {/* Shown even when the node has none: an empty `{}` reads as "any JSON accepted" and keeps the
            block a fixed slot the person can rely on, not one that appears and disappears per node. */}
        <JsonView value={node.outputSchema ?? {}} />
        {node.outputSchema === null && (
          <p className="pane-note" data-testid="awaiting-output-schema-empty">
            No output schema on this step — any JSON output is accepted.
          </p>
        )}
      </section>

      <CompleteForm
        client={client}
        stepRunId={run.runId}
        outputSchema={node.outputSchema}
        launchSecretKeys={launchSecretKeys}
        onCompleted={() => {}}
      />
    </section>
  );
}
