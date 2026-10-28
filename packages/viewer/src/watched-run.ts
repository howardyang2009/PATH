import type { PathApiClient } from "@path/client-core";
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
