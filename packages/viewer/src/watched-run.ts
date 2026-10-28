import {
  EMPTY_RUN_FILE_SET,
  type PathApiClient,
  type RunFileSet,
  type RunNodeState,
  type RunStatus,
  runFileSetFromDisk,
  type WorkflowFile,
} from "@path/client-core";
import { useResource } from "./use-resource.js";
import { type RunSelection, useRunSelection } from "./use-run-selection.js";
import { type RunViewLoad, useRunView } from "./use-run-view.js";

/** One console's watched run: which root run and node run are selected, and the live view of that
 * root. One value, so the runs list and the run detail read one selection over one connection. */
export interface WatchedRun {
  selection: RunSelection;
  load: RunViewLoad;
}

/** The watched run of one console; `scopeKey` re-bases the selection as `useRunSelection` says. */
export function useWatchedRun(client: PathApiClient, scopeKey?: string | null): WatchedRun {
  const selection = useRunSelection(scopeKey);
  const load = useRunView(client, selection.rootRunId);
  return { selection, load };
}

/**
 * What a console reads off the watched run, decided once: the source path its rows record, the
 * files its node ids resolve against, the selected node run, and the root's display status. The
 * Viewer and the Designer's run dock mount this same reading, so the two surfaces cannot drift on
 * which file set backs an awaiting leaf or which row is "the selected run".
 */
export interface WatchedRunReading {
  /** The watched root run's source workflow path, or `null` while unknown. */
  rootWorkflowPath: string | null;
  /** The files a run's node ids resolve against; the empty set while unread (ADR 0040, ADR 0076). */
  runFiles: RunFileSet;
  /** The watched root run's own file, when the set resolved it. */
  rootFile: WorkflowFile | null;
  /** The node run selected in the tree, from the same live snapshot the tree renders. */
  selectedRun: RunNodeState | undefined;
  /** The watched root run's display status (ADR 0038), or `null` while unknown. */
  rootStatus: RunStatus | null;
}

/**
 * Read the watched run: one snapshot, one file set, one selected row. `fallbackPath` is the file a
 * surface already knows it will watch (the Designer's open file): it starts the file read before
 * the run's own row lands, and the row's recorded path takes over once it does.
 */
export function useWatchedRunReading(
  client: PathApiClient,
  watch: WatchedRun,
  fallbackPath?: string | null,
): WatchedRunReading {
  const { selection, load } = watch;
  const selectedRootRunId = selection.rootRunId;
  // The watched root run's source file, as the live snapshot records it.
  const recordedPath =
    load.phase === "ready" && selectedRootRunId !== null
      ? (load.value.runs.get(selectedRootRunId)?.workflowPath ?? null)
      : null;
  const rootWorkflowPath = recordedPath ?? fallbackPath ?? null;
  // The reachable workflow files (root + transitively-ref'd), read from disk: the eager legal-K
  // check needs the root file, and the awaiting surface needs the whole set, since a
  // `person-activity` leaf can live in a nested file. A null path reads nothing.
  const read = useResource(
    () =>
      rootWorkflowPath === null ? EMPTY_RUN_FILE_SET : runFileSetFromDisk(client, rootWorkflowPath),
    [client, rootWorkflowPath],
    { enabled: rootWorkflowPath !== null },
  );
  const runFiles = read.load.phase === "ready" ? read.load.value : EMPTY_RUN_FILE_SET;
  const selectedRun =
    load.phase === "ready" && selection.selectedRunId !== null
      ? load.value.runs.get(selection.selectedRunId)
      : undefined;
  const rootStatus =
    load.phase === "ready" && selectedRootRunId !== null
      ? (load.value.displayStatus.get(selectedRootRunId) ?? load.value.status)
      : null;
  return { rootWorkflowPath, runFiles, rootFile: runFiles.rootFile, selectedRun, rootStatus };
}
