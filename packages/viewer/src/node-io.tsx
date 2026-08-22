import { isTerminal, type PathApiClient, type RunNodeState } from "@path/client-core";
import { useState } from "react";
import { JsonView } from "./json-view.js";
import { nodeLabel } from "./node-label.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { StatusPill } from "./status-pill.js";
import { useRunBlob, type BlobLoad } from "./use-run-blob.js";

export interface NodeIoProps {
  client: PathApiClient;
  /** The run selected in the tree, as the live snapshot holds it — one step's run. */
  run: RunNodeState;
}

/**
 * The node-I/O read surface: the selected run's input and output objects, in the right pane of the
 * pinned console (#44 Variant A). A step has exactly one input object and one output object
 * (CONTEXT.md §Invariants), so the pane is two blocks, not a list. The bytes arrive already
 * secret-masked — masking happens at the persistence boundary (CONTEXT.md §Secret) — so this pane
 * never masks anything itself; it renders what the server serves.
 *
 * The pane reads the run from the same live snapshot the tree renders, so when the run finishes and
 * its `output_ref` appears, the output object is re-read on its own: watching a run is not a verb
 * that stops at the pane boundary (map #40). Refresh stays for the one case the refs cannot signal —
 * re-reading an unchanged ref.
 */
export function NodeIo({ client, run }: NodeIoProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const settled = isTerminal(run.status);
  const blob = { client, rootRunId: run.rootRunId, runId: run.runId, settled, reloadToken };
  const input = useRunBlob({ ...blob, name: "input", ref: run.inputRef });
  const output = useRunBlob({ ...blob, name: "output", ref: run.outputRef });

  return (
    <div className="node-io">
      <header className="node-io-head" data-testid="node-io-head">
        <span className="node-id">{nodeLabel(run.nodeId)}</span>
        <StatusPill status={run.status} />
        <button
          type="button"
          className="card-action"
          data-testid="node-io-refresh"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          Refresh
        </button>
      </header>
      <p className="node-io-run">
        <span className="run-id">{run.runId}</span>
      </p>

      {run.reusedFromRunId !== null && (
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

      <BlobBlock
        title="Input"
        load={input}
        blobRef={run.inputRef}
        testId="node-io-input"
        absentNote="No input object recorded for this run."
      />
      <BlobBlock
        title="Output"
        load={output}
        blobRef={run.outputRef}
        testId="node-io-output"
        // Two different absences: a run still going has not written its output, a finished one never
        // did. Saying "yet" about a finished run promises something that is not coming.
        absentNote={
          settled
            ? "No output object recorded for this run."
            : "No output object yet — a run writes its output when it finishes."
        }
      />
    </div>
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
