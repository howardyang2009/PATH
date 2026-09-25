import type { RunStatus } from "@path/schema";
import type { EligibilityVerdict, ListEligibleResult, ResumeResult } from "./project.js";

/**
 * One owner for how a `path run` / `path runs` outcome reads to an operator — the exit code, the
 * stdout lines, and the stderr narration — as a **pure value**, with no `io` of its own.
 *
 * The rendering used to interleave exit-code choice, operator wording, and table layout with
 * `io.log` / `io.error` side effects inside `cli.ts`, so asserting the wording meant injecting a fake
 * `io` and reading back what it captured. Here each renderer returns a {@link RunReport}; the CLI's one
 * `emit` shell prints its lines and returns its code. The renderers are pure and unit-tested directly.
 */

/** The exit code for a run the operator stopped with `^C` (git's 128 + SIGINT). */
export const SIGINT_EXIT_CODE = 130;

/** A rendered CLI outcome: the lines to print on each stream, and the process exit code. */
export interface RunReport {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/**
 * Maps a settled run's terminal status to its stderr narration and exit code, shared by fresh and
 * resumed runs (#177) so the two can't drift on how a cancel or failure reads. `cancelled` (the
 * unwind the operator's `^C` was owed) and `failed` narrate identically for both; success returns 0
 * and prints nothing, leaving each caller to own its happy-path output — a fresh run prints the
 * workflow output, a resumed run has already printed the successor's root run id.
 */
export function renderRunOutcome(status: RunStatus, error: string | undefined): RunReport {
  if (status === "cancelled") return { stdout: [], stderr: ["run cancelled"], exitCode: SIGINT_EXIT_CODE };
  if (status === "failed") return { stdout: [], stderr: [`run failed: ${error}`], exitCode: 1 };
  // A run that parked at a person-activity leaf (ADR 0039/0041): it is neither done nor broken, so it
  // exits 0 with a note rather than a failure. The engine tore down; the parked leaf lives in the
  // store and is resolved later through Complete (the server's `POST /complete`, not `path run`).
  if (status === "awaiting") return { stdout: [], stderr: ["run is awaiting completion of a person-activity step"], exitCode: 0 };
  return { stdout: [], stderr: [], exitCode: 0 };
}

/**
 * A resumed run's CLI outcome (#177). An unknown root run id is an ordinary operator mistake — a
 * typo — so it exits 1 with the engine's own "no run found" message, never silently doing something
 * else. Otherwise the successor's fresh root run id is printed on *every* outcome (succeeded,
 * failed, cancelled alike), so the operator can inspect it or chain a further `--resume` regardless
 * of how it ended; the exit code and any error/cancel message then mirror a fresh run's.
 */
export function renderResume(result: ResumeResult): RunReport {
  if (!result.found) {
    // A Resume-from-K refusal (#444) and an unknown root run both exit 1 (every engine refusal
    // collapses to 1; the command parsed, the engine refused — spec §7.2). The CLI prints the
    // engine's `refusal.message` verbatim, so there is one wording authority across route / CLI.
    return { stdout: [], stderr: ["refusal" in result ? result.refusal.message : result.error], exitCode: 1 };
  }
  const outcome = renderRunOutcome(result.status, result.error);
  return { ...outcome, stdout: [result.rootRunId, ...outcome.stdout] };
}

const ELIGIBLE_TABLE_HEADERS = ["run-id", "node-name", "status", "eligible?"] as const;

// The `eligible?` cell (#446, spec §6): `yes` for a legal K, otherwise one reason rendered 1:1 from the
// §5 taxonomy the engine's verdict classified it as. This is the one place the taxonomy codes become
// operator-facing wording, distinct from the verbatim `--from` refusal message; the locus reason names
// the innermost enclosing controller the verdict carried (`inside a loop body`).
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
      // The verdict always carries a container for an in-body node; the fallback keeps the cell truthful
      // if a future locus ever lacks one, rather than printing a bare "inside a  body".
      return `inside a ${verdict.container ?? "loop, parallel, or branch"} body`;
    case "not-succeeded":
      return "not succeeded";
    case "prefix-unsucceeded":
      return "prefix not all succeeded";
    case "not-in-tree":
      // Unreachable on a listed row — every row is a run of the tree being listed (spec §6) — but the
      // exhaustive switch must account for it.
      return "not in the run tree";
  }
}

/**
 * `--list-eligible`'s outcome (#446, spec §7): an unknown root run or a non-terminal source refuses the
 * whole command with the engine's own message and exits 1 — the same message and code a real resume of
 * this root gives. Otherwise the four-column listing prints and exits 0; it is never empty (the root row
 * is always shown).
 */
export function renderListEligible(result: ListEligibleResult): RunReport {
  if (!result.found) return { stdout: [], stderr: [result.error], exitCode: 1 };
  const rows = result.rows.map((row): readonly string[] => [
    // The run id is never truncated — the operator copies it into `--from` (spec §5). `node-name` is `-`
    // when the row records none (the root run).
    row.runId,
    row.nodeName ?? "-",
    row.status,
    eligibilityCell(row.verdict),
  ]);
  return { stdout: [formatTable(ELIGIBLE_TABLE_HEADERS, rows)], stderr: [], exitCode: 0 };
}

export const RUNS_TABLE_HEADERS = ["root-run-id", "workflow", "status", "started", "finished", "resumed-from"] as const;

/** One rendered row of the `path runs` listing — a cell per header, in header order. */
export type RunsTableRow = [string, string, string, string, string, string];

// Space-aligned columns (#174): a header line, then every column but the last padded to its widest
// cell so the last (and any never-truncated id column) carries no trailing padding. Shared by `path
// runs` and `--list-eligible` (#446) so the two listings render identically.
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => row[col]!.length)));
  const line = (cols: readonly string[]): string =>
    cols.map((cell, col) => (col < cols.length - 1 ? cell.padEnd(widths[col]!) : cell)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

export function formatRunsTable(rows: readonly RunsTableRow[]): string {
  return formatTable(RUNS_TABLE_HEADERS, rows);
}
