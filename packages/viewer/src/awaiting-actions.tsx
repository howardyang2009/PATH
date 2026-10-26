import type { AwaitingNode, PathApiClient, RunNodeState } from "@path/client-core";
import { useTranslations } from "use-intl";
import { AssigneeChip } from "./assignee-chip.js";
import { CompleteForm } from "./complete-form.js";
import { JsonView } from "./json-view.js";

export interface AwaitingActionsProps {
  client: PathApiClient;
  /** The selected run; the caller mounts this only while its status is `awaiting`. */
  run: RunNodeState;
  /**
   * The step's `person-activity` node, read by id; `null` when the file cannot resolve it (a nested
   * file, a retyped node) — the surface then degrades to a schema-less submit rather than inventing
   * a form.
   */
  awaitingNode: AwaitingNode | null;
  /**
   * The launch config paths the tree recorded as `$secret`-masked (ADR 0046). Non-empty, the
   * Complete form asks for them again: a frozen `[secret:<key>]` token cannot run, so the engine
   * refuses.
   */
  launchSecretKeys?: readonly string[];
}

/** The schema-less fallback when the node cannot be read. */
const FALLBACK_NODE: AwaitingNode = { description: null, assignee: null, outputSchema: null };

/** The awaiting step's Complete surface, inline in the node I/O panel: description, assignee,
 * output
 *  schema and form. Completion folds into the live snapshot; nothing is torn down here. */
export function AwaitingActions({
  client,
  run,
  awaitingNode,
  launchSecretKeys,
}: AwaitingActionsProps) {
  const t = useTranslations("shared.awaitingActions");
  const node = awaitingNode ?? FALLBACK_NODE;

  return (
    <section className="awaiting-actions" data-testid="awaiting-actions" aria-label={t("label")}>
      {node.assignee !== null && <AssigneeChip assignee={node.assignee} />}
      {node.description !== null && (
        <p className="awaiting-callout" data-testid="awaiting-description">
          {node.description}
        </p>
      )}
      {awaitingNode === null && (
        <p className="pane-note" data-testid="awaiting-unresolved">
          {t("unresolved")}
        </p>
      )}

      <section
        className="io-block"
        data-testid="awaiting-output-schema"
        aria-labelledby="awaiting-output-schema-title"
      >
        <h3 className="io-title" id="awaiting-output-schema-title">
          {t("outputSchema")}
        </h3>
        {/* Shown even when empty: `{}` reads as "any JSON accepted" and keeps the block a fixed
          slot. */}
        <JsonView value={node.outputSchema ?? {}} />
        {node.outputSchema === null && (
          <p className="pane-note" data-testid="awaiting-output-schema-empty">
            {t("noOutputSchema")}
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
