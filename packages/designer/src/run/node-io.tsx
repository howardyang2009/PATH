import { isReuseRow, isTerminal, nodeLabel, type PathApiClient, type RunNodeState } from "@path/client-core";
import { useState } from "react";
import { JsonView } from "./json-view.js";
import { RunStatusPill } from "./run-status.js";
import { useRunBlob, type BlobLoad } from "./use-run-blob.js";

export interface NodeIoProps {
  client: PathApiClient;
  /** The run selected in the inspector tree, as the live snapshot holds it — one step's run. */
  run: RunNodeState;
}

/**
 * The node I/O surface (surface 7, ADR 0025): the selected run's `input`, `output`, and `context`
 * objects — *which step broke and what did it see*. A step has one input and one output object
 * (CONTEXT.md §Invariants), and every leaf step records a snapshot of the workflow-run's `context`
 * blackboard as it stood when the step finished. The bytes arrive already secret-masked (masking is a
 * persistence-boundary concern, CONTEXT.md §Secret) — this pane renders what the server serves.
 *
 * The pane reads the run from the same live snapshot the tree renders, so when the run finishes and its
 * `output_ref` appears, the output is re-read on its own. Refresh stays for the one case the refs cannot
 * signal — re-reading an unchanged ref, and re-reading `context` (which has no ref column).
 */
export function NodeIo({ client, run }: NodeIoProps): JSX.Element {
  const [reloadToken, setReloadToken] = useState(0);
  const settled = isTerminal(run.status);
  const blob = { client, rootRunId: run.rootRunId, runId: run.runId, settled, reloadToken };
  const input = useRunBlob({ ...blob, name: "input", ref: run.inputRef });
  const output = useRunBlob({ ...blob, name: "output", ref: run.outputRef });
  // No `context_ref` rides on a run row, so read unconditionally and trust the 404 (the shared absence
  // rule's `ref: null, settled: true`): a workflow-run has context, a leaf step 404s and reads as absent.
  const context = useRunBlob({ ...blob, name: "context", ref: null, settled: true });

  return (
    <div className="run-node-io" data-testid="run-node-io">
      <header className="run-node-io-head">
        <span className="run-node-io-name">{run.nodeName ?? nodeLabel(run.nodeId)}</span>
        <RunStatusPill status={run.status} />
        <button
          type="button"
          className="run-node-io-refresh"
          data-testid="run-node-io-refresh"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          Refresh
        </button>
      </header>
      <p className="run-node-io-run">
        <span className="run-row-id">{run.runId}</span>
      </p>

      {isReuseRow(run) && (
        <p className="run-node-io-reused" data-testid="run-node-io-reused">
          Reused from an earlier run — the input and output below are that run's.
        </p>
      )}

      <BlobBlock
        title="Input"
        load={input}
        testId="run-node-io-input"
        absentNote="No input object recorded for this run."
      />
      <BlobBlock
        title="Output"
        load={output}
        testId="run-node-io-output"
        // Two different absences: a run still going has not written its output, a finished one never did.
        // Saying "yet" about a finished run promises something that is not coming.
        absentNote={
          settled
            ? "No output object recorded for this run."
            : "No output object yet — a run writes its output when it finishes."
        }
      />
      <BlobBlock
        title="Context"
        load={context}
        testId="run-node-io-context"
        absentNote="No context recorded for this run."
      />
    </div>
  );
}

interface BlobBlockProps {
  title: string;
  load: BlobLoad;
  testId: string;
  /** What an absent object means here — the three go missing for different reasons. */
  absentNote: string;
}

function BlobBlock({ title, load, testId, absentNote }: BlobBlockProps): JSX.Element {
  const titleId = `${testId}-title`;
  const label = title.toLowerCase();

  return (
    <section className="run-io-block" data-testid={testId} aria-labelledby={titleId}>
      <h4 className="run-io-title" id={titleId}>
        {title}
      </h4>
      {load.phase === "loading" && <p className="run-note">Loading {label}…</p>}
      {load.phase === "error" && (
        <p className="run-note run-error" role="alert">
          Failed to load {label}: {load.message}
        </p>
      )}
      {load.phase === "ready" &&
        (load.value.present ? <JsonView value={load.value.value} /> : <p className="run-note">{absentNote}</p>)}
    </section>
  );
}
