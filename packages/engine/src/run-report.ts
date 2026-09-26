import type { RunStatus } from "@path/schema";
import type { EligibilityVerdict, ListEligibleResult, ResumeResult } from "./project.js";

/** How a `path run` / `path runs` outcome reads to an operator: exit code, stdout lines, stderr narration. */

/** The exit code for a run the operator stopped with `^C` (git's 128 + SIGINT). */
export const SIGINT_EXIT_CODE = 130;

/** A rendered CLI outcome: the lines to print on each stream, and the process exit code. */
export interface RunReport {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/** Maps a settled run's terminal status to its stderr narration and exit code, shared by fresh and
 * resumed runs so the two cannot drift. `awaiting` is neither done nor broken: it exits 0 with a note
 * (ADR 0038) because the parked leaf is resolved later through the server's Complete. */
export function renderRunOutcome(status: RunStatus, error: string | undefined): RunReport {
  if (status === "cancelled")
    return { stdout: [], stderr: ["run cancelled"], exitCode: SIGINT_EXIT_CODE };
  if (status === "failed") return { stdout: [], stderr: [`run failed: ${error}`], exitCode: 1 };
  if (status === "awaiting")
    return {
      stdout: [],
      stderr: ["run is awaiting completion of a person-activity step"],
      exitCode: 0,
    };
  return { stdout: [], stderr: [], exitCode: 0 };
}

/** A resumed run's CLI outcome: an unknown root run id is an ordinary operator typo and exits 1;
 * otherwise the successor's root run id prints on every outcome so the operator can inspect it or
 * chain a further `--resume`. */
export function renderResume(result: ResumeResult): RunReport {
  if (!result.found) {
    // A Resume-from-K refusal and an unknown root run both exit 1; the CLI prints the engine's message
    // verbatim, so route and CLI share one wording authority.
    return {
      stdout: [],
      stderr: ["refusal" in result ? result.refusal.message : result.error],
      exitCode: 1,
    };
  }
  const outcome = renderRunOutcome(result.status, result.error);
  return { ...outcome, stdout: [result.rootRunId, ...outcome.stdout] };
}

const ELIGIBLE_TABLE_HEADERS = ["run-id", "node-name", "status", "eligible?"] as const;

// The `eligible?` cell: `yes` for a legal K, otherwise one reason per the engine verdict's §5 taxonomy —
// the one place those codes become operator wording. The locus reason names the innermost controller.
function eligibilityCell(verdict: EligibilityVerdict): string {
  if (verdict.eligible) return "yes";
  switch (verdict.reason) {
    case "root-run":
      return "root run (never a boundary)";
    case "pass-run":
      return "goto pass (never a boundary)";
    case "not-in-file":
      return "not in current file";
    case "in-body":
      return `inside a ${verdict.container ?? "loop, parallel, or branch"} body`;
    case "not-succeeded":
      return "not succeeded";
    case "prefix-unsucceeded":
      return "prefix not all succeeded";
    case "not-in-tree":
      // Unreachable on a listed row, but the exhaustive switch must account for it.
      return "not in the run tree";
  }
}

/** `--list-eligible`'s outcome: an unknown root run or a non-terminal source refuses the whole command
 * with the engine's own message and exits 1; otherwise the four-column listing prints, never empty. */
export function renderListEligible(result: ListEligibleResult): RunReport {
  if (!result.found) return { stdout: [], stderr: [result.error], exitCode: 1 };
  const rows = result.rows.map((row): readonly string[] => [
    // The run id is never truncated — the operator copies it into `--from`.
    row.runId,
    row.nodeName ?? "-",
    row.status,
    eligibilityCell(row.verdict),
  ]);
  return { stdout: [formatTable(ELIGIBLE_TABLE_HEADERS, rows)], stderr: [], exitCode: 0 };
}

const RUNS_TABLE_HEADERS = [
  "root-run-id",
  "workflow",
  "status",
  "started",
  "finished",
  "resumed-from",
] as const;

/** One rendered row of the `path runs` listing — a cell per header, in header order. */
export type RunsTableRow = [string, string, string, string, string, string];

// Space-aligned columns: every column but the last padded to its widest cell.
function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => row[col]!.length)),
  );
  const line = (cols: readonly string[]): string =>
    cols.map((cell, col) => (col < cols.length - 1 ? cell.padEnd(widths[col]!) : cell)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

export function formatRunsTable(rows: readonly RunsTableRow[]): string {
  return formatTable(RUNS_TABLE_HEADERS, rows);
}
