import {
  awaitingNodeForRun,
  isReuseRow,
  isRootRun,
  isTerminal,
  nodeLabel,
  runBlobSource,
  type PathApiClient,
  type RunNodeState,
  type RunViewFacts,
  type WorkflowFile,
} from "@path/client-core";
import { useState } from "react";
import { AwaitingActions } from "./awaiting-actions.js";
import { JsonView } from "./json-view.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { StatusPill } from "./status-pill.js";
import { useRunBlob, type BlobLoad } from "./use-run-blob.js";

export interface NodeIoProps {
  client: PathApiClient;
  /** The run selected in the tree, as the live snapshot holds it — one step's run. */
  run: RunNodeState;
  /**
   * The watched run's derived facts (`RunViewFacts`): its display status — a running run with an
   * awaiting run below reads `awaiting`, the same fact the rail and the run-detail head read — and the
   * failure message it reached. The view owns both, so this pane asks rather than re-deriving them from
   * the run map and the event narrative; absent before anything is watched, and the pane then shows the
   * run's own record status and no error. Only the pill and the E block use it; the Complete surface and
   * the blob reads stay keyed on the real `run.status`. It also carries the tree's `launchFacts`
   * (ADR 0046), which the root run's override sections and the Complete form's masked-secret prefill read.
   */
  view?: RunViewFacts;
  /**
   * The watched run's reachable workflow files, parsed structurally: the root file and every file its
   * `workflow` steps ref, transitively (`loadReachableWorkflowFiles`). An `awaiting` leaf's
   * `description`/`assignee`/`outputSchema` live on the node in the file that defines it, not on the run
   * row, so the Complete surface resolves them by node id — and that file can be a nested one, not only
   * the root (issue #486 follow-up). Empty while it loads or when the files could not be read; the
   * awaiting surface then degrades to a schema-less submit.
   */
  workflowFiles?: readonly WorkflowFile[];
}

/**
 * The node-I/O/C read surface: the selected run's input, output, and context objects, in the right
 * pane of the pinned console (#44 Variant A). A step has exactly one input object and one output
 * object (CONTEXT.md §Invariants), and now a context object too: a workflow-run keeps its own
 * `context.json` blackboard (format §6.3), and every leaf step records a snapshot of that context as
 * it stood when the step finished, so the Context block lets you follow the context evolve step by
 * step. The bytes arrive already secret-masked — masking happens at the persistence boundary
 * (CONTEXT.md §Secret) — so this pane never masks anything itself; it renders what the server serves.
 *
 * Which run each object is read from, whether its ref gates the read, and the provenance line beside it
 * are `@path/client-core`'s `runBlobSource` — the one owner of the blob layout a surface may know
 * (there is no `context_ref` on a run row, and a **successor root** reads the predecessor's input). This
 * pane keeps only its wiring: three `useRunBlob` calls and the blocks that draw them.
 *
 * The pane reads the run from the same live snapshot the tree renders, so when the run finishes and
 * its `output_ref` appears, the output object is re-read on its own: watching a run is not a verb
 * that stops at the pane boundary (map #40). Refresh stays for the one case the refs cannot signal —
 * re-reading an unchanged ref. Context has no ref column of its own, so it is always fetched and its
 * 404 trusted as "no context recorded" (`runBlobSource`'s null gate); Refresh re-reads it after a
 * write-through changes it.
 */
export function NodeIo({ client, run, view, workflowFiles = [] }: NodeIoProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const settled = isTerminal(run.status);
  // Both head facts come off the view's snapshot (a running run with an awaiting run below reads
  // `awaiting`; the error is the last failed `step-finished` for this run). Everything else on this run
  // — the Complete surface, the blob settling — stays on the real `run.status`, because a flipped
  // ancestor is not itself awaiting and has no completion to make. With nothing watched, the head falls
  // back to the run's own record status and shows no error.
  const displayStatus = view?.displayStatus.get(run.runId) ?? run.status;
  const errorMessage = view?.lastError.get(run.runId) ?? null;
  // The tree's frozen launch facts (ADR 0046). A per-tree fact, so the override sections render only on
  // the tree's root run, while `secretKeys` reaches the Complete form wherever the awaiting leaf sits.
  const launchFacts = view?.launchFacts;
  // An awaiting leaf is the one actionable run: surface its Complete affordance. The node's fields come
  // from the workflow file by id (they never ride the run row); the file may be the root or any nested
  // one its `workflow` steps ref, so the search spans the whole reachable set (issue #486 follow-up). A
  // leaf the set cannot resolve reads as null and the surface degrades. The root run stays `running`
  // while a leaf awaits (ADR 0038), so only the leaf row itself carries this.
  const awaitingNode = awaitingNodeForRun(workflowFiles, run);
  const inputSource = runBlobSource(run, "input");
  const outputSource = runBlobSource(run, "output");
  const contextSource = runBlobSource(run, "context");
  const resumedFrom = inputSource.resumedFrom;
  const input = useRunBlob({
    client,
    rootRunId: inputSource.rootRunId,
    runId: inputSource.runId,
    name: "input",
    ref: inputSource.gatedBy,
    settled: settled || resumedFrom !== null,
    reloadToken,
  });
  const output = useRunBlob({
    client,
    rootRunId: outputSource.rootRunId,
    runId: outputSource.runId,
    name: "output",
    ref: outputSource.gatedBy,
    settled,
    reloadToken,
  });
  // No `context_ref` rides on a run row, so there is no ref to gate the read or to signal a change:
  // read unconditionally and trust the 404 (a workflow-run has context, a leaf step 404s and reads as
  // absent) — the same shape as an output object a run never recorded.
  const context = useRunBlob({
    client,
    rootRunId: contextSource.rootRunId,
    runId: contextSource.runId,
    name: "context",
    ref: contextSource.gatedBy,
    settled: true,
    reloadToken,
  });

  return (
    <div className="node-io">
      <header className="node-io-head" data-testid="node-io-head">
        <span className="node-name">{run.nodeName ?? nodeLabel(run.nodeId)}</span>
        <StatusPill status={displayStatus} />
        <button
          type="button"
          className="card-action"
          data-testid="node-io-refresh"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          Refresh
        </button>
        <span className="node-io-id-line">
          <span className="node-id-label">node id</span>
          <span className="node-id">{run.nodeId ?? "—"}</span>
        </span>
      </header>
      <p className="node-io-run">
        <span className="run-id-label">run id</span>
        <span className="run-id">{run.runId}</span>
      </p>

      {run.status === "awaiting" && (
        <AwaitingActions
          client={client}
          run={run}
          awaitingNode={awaitingNode}
          launchSecretKeys={launchFacts?.secretKeys}
        />
      )}

      {isReuseRow(run) && (
        <p className="node-io-reused" data-testid="node-io-reused">
          Reused from an earlier run — the input and output below are that run's.
          <span className="reused-ref">
            <span className="reused-label">reused root run</span>
            <span className="run-id">{run.reusedFromRootRunId ?? "(deleted)"}</span>
          </span>
          <span className="reused-ref">
            <span className="reused-label">reused run</span>
            <span className="run-id">{run.reusedFromRunId}</span>
          </span>
        </p>
      )}

      {resumedFrom !== null && (
        <p className="node-io-reused" data-testid="node-io-resumed-input">
          Resumed from an earlier run — the input below is that run's root input.
          <span className="reused-ref">
            <span className="reused-label">resumed-from root run</span>
            <span className="run-id">{resumedFrom}</span>
          </span>
        </p>
      )}

      <BlobBlock
        title="Input"
        load={input}
        blobRef={inputSource.ref}
        testId="node-io-input"
        absentNote={
          resumedFrom === null
            ? "No input object recorded for this run."
            : "The resumed-from run recorded no input object."
        }
      />
      <BlobBlock
        title="Output"
        load={output}
        blobRef={outputSource.ref}
        testId="node-io-output"
        // Two different absences: a run still going has not written its output, a finished one never
        // did. Saying "yet" about a finished run promises something that is not coming.
        absentNote={
          settled
            ? "No output object recorded for this run."
            : "No output object yet — a run writes its output when it finishes."
        }
      />
      <BlobBlock
        title="Context"
        load={context}
        // Context has no ref column; its on-disk provenance is derived from a sibling blob's ref so the
        // line reads like Input's and Output's (`runs/<root>/<run>/context.json`).
        blobRef={contextSource.ref}
        testId="node-io-context"
        // A succeeded run records a context; an absent one is a run still in flight or one that never
        // reached a verdict — not a failure of the pane.
        absentNote="No context recorded for this run."
      />
      {isRootRun(run) && launchFacts !== undefined && (
        <>
          {/* The operator's launch facts (ADR 0046), on the root run alone: they belong to the tree, not
              to any one node. Each section appears only when the launch actually supplied that fact, so a
              bare launch adds nothing here. `config` is shown masked — the `[secret:<key>]` token is the
              truth of what the run stored, not something to hide. */}
          {launchFacts.input !== undefined && (
            <FactBlock title="Override Input" testId="node-io-override-input" value={launchFacts.input} />
          )}
          {launchFacts.config !== undefined && (
            <FactBlock title="Override Config" testId="node-io-override-config" value={launchFacts.config} />
          )}
          {launchFacts.workerDefaults !== undefined && (
            <FactBlock
              title="Launch Worker Defaults"
              testId="node-io-launch-worker-defaults"
              value={launchFacts.workerDefaults}
            />
          )}
        </>
      )}
      {errorMessage !== null && <ErrorBlock message={errorMessage} />}
    </div>
  );
}

/**
 * One launch-fact block on the root run, rendered with the same section markup and heading id as the
 * I/O/C `BlobBlock`s so the pane reads as one stack. Unlike those blocks it holds a value already in
 * the snapshot rather than a served blob, so it carries no ref line and no absence note: the caller
 * renders it only when the fact exists.
 */
function FactBlock({ title, testId, value }: { title: string; testId: string; value: unknown }) {
  const titleId = `${testId}-title`;
  return (
    <section className="io-block" data-testid={testId} aria-labelledby={titleId}>
      <h3 className="io-title" id={titleId}>
        {title}
      </h3>
      <JsonView value={value} />
    </section>
  );
}

/**
 * The E block: the run's own failure message. Rendered only when the run actually failed — unlike the
 * I/O/C blocks, which are slots every run legitimately has (so an absent-note there is informative),
 * an error is the exception, not a slot. A success, a still-running or a cancelled run has no error,
 * so the block stays absent rather than announcing "no error" on every healthy run. The message is a
 * plain string the view folded off the run's `step-finished` event, so it renders verbatim, as JSON it
 * is not.
 */
function ErrorBlock({ message }: { message: string }) {
  return (
    <section className="io-block" data-testid="node-io-error" aria-labelledby="node-io-error-title">
      <h3 className="io-title" id="node-io-error-title">
        Error
      </h3>
      <pre className="node-io-error-message">{message}</pre>
      {/* The error text is not a served blob file: it rides the run's `step-finished` event in the
          event log (mvp spec §8.1), so its provenance is that event, not a filename like the I/O/C
          blocks carry. The line reads in the same muted style so the four blocks stay visually kin. */}
      <p className="blob-ref">from the run's step-finished event (event log)</p>
    </section>
  );
}

interface BlobBlockProps {
  title: string;
  load: BlobLoad;
  /** The run record's ref, shown as the on-disk provenance of what is on screen (#44 prototype). */
  blobRef: string | null;
  testId: string;
  /** What an absent object means here — the two go missing for different reasons. */
  absentNote: string;
}

function BlobBlock({ title, load, blobRef, testId, absentNote }: BlobBlockProps) {
  const titleId = `${testId}-title`;
  const label = title.toLowerCase();

  return (
    <section className="io-block" data-testid={testId} aria-labelledby={titleId}>
      <h3 className="io-title" id={titleId}>
        {title}
      </h3>
      {load.phase === "loading" && <PaneLoading what={label} />}
      {load.phase === "error" && <PaneError what={label} message={load.message} />}
      {load.phase === "ready" &&
        (load.value.present ? (
          <>
            <JsonView value={load.value.value} />
            {blobRef !== null && <p className="blob-ref">{blobRef}</p>}
          </>
        ) : (
          <p className="pane-note">{absentNote}</p>
        ))}
    </section>
  );
}
