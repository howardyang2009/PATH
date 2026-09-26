import {
  awaitingNodeForRun,
  isReuseRow,
  isRootRun,
  isTerminal,
  nodeLabel,
  type PathApiClient,
  type RunNodeState,
  type RunViewFacts,
  runBlobSource,
  type WorkflowFile,
} from "@path/client-core";
import { useState } from "react";
import { AwaitingActions } from "./awaiting-actions.js";
import { JsonView } from "./json-view.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { StatusPill } from "./status-pill.js";
import { type BlobLoad, useRunBlob } from "./use-run-blob.js";

export interface NodeIoProps {
  client: PathApiClient;
  /** The run selected in the tree, as the live snapshot holds it — one step's run. */
  run: RunNodeState;
  /**
   * The watched run's derived facts (`RunViewFacts`): display status, last error, and the tree's
   * `launchFacts` (ADR 0046) — the view owns them, so this pane asks rather than re-deriving. Only the
   * pill, the E block and the masked-secret surfaces use it; blob reads stay keyed on the real
   * `run.status`.
   */
  view?: RunViewFacts;
  /**
   * The watched run's reachable workflow files, parsed structurally. An awaiting leaf's
   * `description`/`assignee`/`outputSchema` live on the node in the file that defines it — possibly a
   * nested one — so the Complete surface resolves them by node id; empty means it degrades to a
   * schema-less submit.
   */
  workflowFiles?: readonly WorkflowFile[];
}

/**
 * The node-I/O/C read surface: the selected run's input, output and context objects. Masking happens at
 * the persistence boundary, so this pane renders what the server serves and never masks anything itself.
 *
 * Which run each object is read from, and whether its ref gates the read, is `@path/client-core`'s
 * `runBlobSource`; this pane keeps only the wiring: three `useRunBlob` calls and their blocks. Context
 * has no ref column, so it is always fetched and its 404 read as "no context recorded".
 */
export function NodeIo({ client, run, view, workflowFiles = [] }: NodeIoProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const settled = isTerminal(run.status);
  // Head facts (display status, last error) come off the view's snapshot; everything else stays on the
  // real `run.status`, because a flipped ancestor is not itself awaiting. Unwatched, the head falls back
  // to the run's own record status and shows no error.
  const displayStatus = view?.displayStatus.get(run.runId) ?? run.status;
  const errorMessage = view?.lastError.get(run.runId) ?? null;
  // The tree's frozen launch facts (ADR 0046): per-tree, so the override sections render on the root run
  // alone while `secretKeys` reaches the Complete form wherever the awaiting leaf sits.
  const launchFacts = view?.launchFacts;
  // An awaiting leaf is the one actionable run. Its node fields come from the workflow file by id — the
  // file may be nested, so the search spans the whole reachable set; unresolved reads as null.
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
  // No `context_ref` rides a run row, so this read is ungated and a 404 reads as "no context recorded".
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
        // A run still going has not written its output, a finished one never did; "yet" would promise
        // something that is not coming.
        absentNote={
          settled
            ? "No output object recorded for this run."
            : "No output object yet — a run writes its output when it finishes."
        }
      />
      <BlobBlock
        title="Context"
        load={context}
        // Context's on-disk provenance is derived from a sibling blob's ref so the line reads like
        // Input's and Output's (`runs/<root>/<run>/context.json`).
        blobRef={contextSource.ref}
        testId="node-io-context"
        // An absent context is a run still in flight or one that never reached a verdict — not a failure.
        absentNote="No context recorded for this run."
      />
      {isRootRun(run) && launchFacts !== undefined && (
        <>
          {/* The operator's launch facts (ADR 0046), on the root run alone; each section renders only when
              the launch supplied it. `config` is shown masked — the token is what the run stored. */}
          {launchFacts.input !== undefined && (
            <FactBlock
              title="Override Input"
              testId="node-io-override-input"
              value={launchFacts.input}
            />
          )}
          {launchFacts.config !== undefined && (
            <FactBlock
              title="Override Config"
              testId="node-io-override-config"
              value={launchFacts.config}
            />
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
 * One launch-fact block on the root run: the same section markup as the I/O/C `BlobBlock`s, but holding
 * a value already in the snapshot rather than a served blob — no ref line, no absence note.
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
 * The E block: the run's failure message, rendered only when the run actually failed — unlike the I/O/C
 * blocks, which are slots every run legitimately has, an error is the exception. The message is a plain
 * string the view folded off the run's `step-finished` event, so it renders verbatim, not as JSON.
 */
function ErrorBlock({ message }: { message: string }) {
  return (
    <section className="io-block" data-testid="node-io-error" aria-labelledby="node-io-error-title">
      <h3 className="io-title" id="node-io-error-title">
        Error
      </h3>
      <pre className="node-io-error-message">{message}</pre>
      {/* The error rides the run's `step-finished` event, not a served blob file, so its provenance is
          that event rather than a filename. */}
      <p className="blob-ref">from the run's step-finished event (event log)</p>
    </section>
  );
}

interface BlobBlockProps {
  title: string;
  load: BlobLoad;
  /** The run record's ref, shown as the on-disk provenance of what is on screen. */
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
