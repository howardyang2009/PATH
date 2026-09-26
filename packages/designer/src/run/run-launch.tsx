import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { LaunchForm } from "@path/viewer";

export interface RunLaunchProps {
  client: PathApiClient;
  /** The received step-plugin registry, passed through to the shared form's launch worker-default field (ADR 0044). */
  plugins: readonly WireStepPlugin[];
  /** The file open on the canvas; `null` for a never-saved buffer. */
  workflowPath: string | null;
  /** A launch runs the bytes on disk, so a dirty buffer gates it (ADR 0025). */
  dirty: boolean;
  /** Soft cross-node warning count; launch is badged, not blocked. */
  warningCount: number;
  onLaunched: (rootRunId: string) => void;
}

/** Save-first launch (ADR 0025): the shared {@link LaunchForm} with no picker; it runs the bytes on disk, so
 * a dirty or never-saved buffer gates it. The worker-default field rides along (ADR 0044). */
export function RunLaunch({
  client,
  plugins,
  workflowPath,
  dirty,
  warningCount,
  onLaunched,
}: RunLaunchProps): JSX.Element {
  const gate =
    workflowPath === null
      ? "Save this new workflow before you can run it."
      : dirty
        ? "Save your edits before you can run — a run uses the file on disk."
        : null;

  return (
    <LaunchForm
      client={client}
      plugins={plugins}
      workflowPath={workflowPath}
      onLaunched={onLaunched}
      submitLabel="Run workflow"
      idBase="run-launch"
      testIdPrefix="run-launch"
      containerTestId="run-launch"
      gate={gate}
      warningCount={warningCount}
    />
  );
}
