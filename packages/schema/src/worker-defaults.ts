import {
  describeUnknownStepType,
  describeUnknownWorker,
  type StepPluginRegistry,
} from "./nodes.js";

/**
 * One registry-relative fault in a worker-default table (ADR 0044): the offending `type` key, and the
 * message describing why the `{ type: worker }` selection is invalid. The two failure classes reuse the
 * node channels' wording — an absent type echoes the type + the installed list + the remedy
 * (`describeUnknownStepType`), an absent worker lists the type's shipped names (`describeUnknownWorker`)
 * — so every surface reports a bad selection in one voice.
 */
export interface WorkerDefaultIssue {
  /** The table key whose entry is invalid. */
  type: string;
  /** The bare taxonomy message; the surface prefixes its own source. */
  message: string;
}

/**
 * The per-entry registry-relative check shared by both channels of ADR 0044's `worker_defaults`
 * validation. A `worker-default` is a *selection* — `{ <type>: <worker-name> }` — so each entry is
 * valid only when the key names an installed step type and the value names a worker that type ships.
 * Every bad entry is collected (aggregate, never first-only), each attributed to its own key, so a
 * caller can report the whole table in one pass. Registry-agnostic *shape* is a separate concern the
 * base schema / request schema fixes; this is the registry-relative half, run once the registry is in
 * hand.
 */
export function collectWorkerDefaultIssues(
  table: { [stepType: string]: string },
  registry: StepPluginRegistry,
): WorkerDefaultIssue[] {
  const issues: WorkerDefaultIssue[] = [];
  for (const [type, workerName] of Object.entries(table)) {
    const entry = registry[type];
    if (!entry) {
      issues.push({ type, message: describeUnknownStepType(type, Object.keys(registry)) });
      continue;
    }
    const workerNames = Object.keys(entry.workers);
    if (!workerNames.includes(workerName)) {
      issues.push({ type, message: describeUnknownWorker(type, workerNames, workerName) });
    }
  }
  return issues;
}

/**
 * The **launch** channel of ADR 0044's two-channel registry-relative validation (#518). A launch
 * worker-default — CLI `--worker-default` or server `worker_defaults` on `POST /v0/runs` — is operator
 * input authored in no file and seen by no Designer, so a bad entry is a bad *request*, not an engine
 * fault: the CLI exits non-zero and the server returns `400` before the run starts. Same taxonomy as
 * the file channel (`checkWorkerDefaults`), a different site, because the two tiers have different
 * authors — the operator fixes their own launch where an author fixes a file.
 *
 * Returns the bare messages, aggregated across every bad entry; the caller prefixes its own source
 * (`--worker-default: …` versus `worker_defaults: …`), the same way the file loader prefixes each file
 * path. An empty result — no table, or every entry valid — means the launch is clean.
 */
export function validateLaunchWorkerDefaults(
  table: { [stepType: string]: string } | undefined,
  registry: StepPluginRegistry,
): string[] {
  if (!table) return [];
  return collectWorkerDefaultIssues(table, registry).map((issue) => issue.message);
}
