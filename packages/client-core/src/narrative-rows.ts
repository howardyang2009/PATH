import { isPassRun, type LogEvent } from "@path/schema";
import type { RunNodeState } from "./view-model.js";

/** The narrative a surface draws: every event except a goto pass container's own `step-started`
 * and `step-finished`. `pass-started` and `goto-taken` already mark where each pass opens and
 * closes, and pass 1's container carries no node, so its rows would read as a second root.
 */
export function narrativeRows(
  narrative: readonly LogEvent[],
  runs: ReadonlyMap<string, RunNodeState>,
): LogEvent[] {
  return narrative.filter((event) => {
    if (event.type !== "step-started" && event.type !== "step-finished") return true;
    const run = runs.get(event.run_id);
    return run === undefined || !isPassRun(run);
  });
}
