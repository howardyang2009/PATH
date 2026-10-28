import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import type { Message } from "@path/i18n";
import type { WorkflowFile } from "@path/schema";
import { LaunchForm } from "@path/viewer";
import { useTranslations } from "use-intl";
import { fileWorkers } from "../effective-worker.js";

export interface RunLaunchProps {
  client: PathApiClient;
  /** The received step-plugin registry, passed through to the shared form's launch worker-default
   * field (ADR 0044). */
  plugins: readonly WireStepPlugin[];
  /** The file open on the canvas; `null` for a never-saved buffer. */
  workflowPath: string | null;
  /** The open buffer's parsed root file, or `null`; its workers name the config placeholder. */
  rootFile: WorkflowFile | null;
  /** A launch runs the bytes on disk, so a dirty buffer gates it (ADR 0025). */
  dirty: boolean;
  /** Soft cross-node warning count; launch is badged, not blocked. */
  warningCount: number;
  onLaunched: (rootRunId: string) => void;
}

/** Save-first launch (ADR 0025): the shared {@link LaunchForm} with no picker; it runs the bytes on
 * disk, so a dirty or never-saved buffer gates it. The worker-default field rides along (ADR
 * 0044). */
export function RunLaunch({
  client,
  plugins,
  workflowPath,
  rootFile,
  dirty,
  warningCount,
  onLaunched,
}: RunLaunchProps): JSX.Element {
  const t = useTranslations();
  const gate: Message | null =
    workflowPath === null
      ? { key: "designer.runLaunch.saveNew" }
      : dirty
        ? { key: "designer.runLaunch.saveEdits" }
        : null;

  return (
    <LaunchForm
      client={client}
      plugins={plugins}
      workers={rootFile === null ? [] : fileWorkers(rootFile, plugins)}
      workflowPath={workflowPath}
      onLaunched={onLaunched}
      submitLabel={t("designer.runLaunch.submit")}
      idBase="run-launch"
      testIdPrefix="run-launch"
      containerTestId="run-launch"
      gate={gate}
      warningCount={warningCount}
    />
  );
}
