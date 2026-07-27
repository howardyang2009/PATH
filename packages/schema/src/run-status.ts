import { z } from "zod";

/**
 * How a run ended, or that it has not (mvp spec §5.7). Run rows exist for step runs only
 * (domain invariant 1).
 *
 * `cancelled` is deliberately distinct from `failed`: an operator stopping a run, or a parallel
 * branch killing its in-flight siblings, is not the workflow breaking (§5.6).
 */
export const RUN_STATUSES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RunStatusSchema = z.enum(RUN_STATUSES);

/** The three statuses a run can end on. A terminal run never moves again. */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const satisfies readonly RunStatus[];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const TerminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);

/**
 * A finished run: something set it, and nothing after that may move it back. The one terminality
 * check, so a surface deciding whether a run can still be acted on — the cancel route refusing a
 * settled run, the viewer's cancel button — names it rather than re-deriving the status set.
 */
export function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
