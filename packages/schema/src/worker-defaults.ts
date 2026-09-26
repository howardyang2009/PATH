import {
  describeUnknownStepType,
  describeUnknownWorker,
  type StepPluginRegistry,
} from "./nodes.js";

/** One registry-relative fault in a worker-default table (ADR 0044): the offending `type` key and its message. */
export interface WorkerDefaultIssue {
  /** The table key whose entry is invalid. */
  type: string;
  /** The bare taxonomy message; the surface prefixes its own source. */
  message: string;
}

/** The per-entry check both channels share (ADR 0044): the type key must be installed and ship that worker. */
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
 * The launch channel (ADR 0044): operator input, so a bad entry is a bad request — CLI exits non-zero, server returns
 * 400.
 */
export function validateLaunchWorkerDefaults(
  table: { [stepType: string]: string } | undefined,
  registry: StepPluginRegistry,
): string[] {
  if (!table) return [];
  return collectWorkerDefaultIssues(table, registry).map((issue) => issue.message);
}
