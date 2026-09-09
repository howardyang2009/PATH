import type { PathApiClient } from "@path/client-core";
import { LaunchForm } from "@path/viewer";

export interface RunLaunchProps {
  client: PathApiClient;
  /** The file open on the canvas — the launch target. `null` for a brand-new, never-saved buffer. */
  workflowPath: string | null;
  /** The active buffer's dirty flag: a launch runs the bytes on disk, so a dirty buffer gates it (ADR 0025). */
  dirty: boolean;
  /**
   * The open file's soft cross-node warning count (#388). Launch is **badged, not blocked**: a
   * saved-with-warnings file is clean, so launch is enabled; the count only tells the author the run
   * may surface the truth at run-start (an unresolved interpolation, an unset `$env`).
   */
  warningCount: number;
  /** Called with the new run's `root_run_id` once a launch is accepted (202) — the app watches it. */
  onLaunched: (rootRunId: string) => void;
}

/**
 * The Designer's launch surface (surface 2, ADR 0025), **save-first**. It is the shared
 * {@link LaunchForm} (reused from `@path/viewer`, the same form the Viewer's launch panel mounts)
 * wired to the Designer's one difference: there is no picker — the target is the file open on the
 * canvas, and a launch runs the **bytes on disk** (the server loads `workflow_path` through
 * `prepareWorkflow`, never the client's buffer). So a dirty or never-saved buffer gates launch until
 * it is saved; the shared form disables the button and shows the gate reason, and enables once clean.
 */
export function RunLaunch({ client, workflowPath, dirty, warningCount, onLaunched }: RunLaunchProps): JSX.Element {
  // A launch runs the file on disk, so an unsaved or dirty buffer must save first (#371, ADR 0025). A
  // brand-new buffer has no path for `prepareWorkflow` to load, so its first save creates the target.
  const gate =
    workflowPath === null
      ? "Save this new workflow before you can run it."
      : dirty
        ? "Save your edits before you can run — a run uses the file on disk."
        : null;

  return (
    <LaunchForm
      client={client}
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
