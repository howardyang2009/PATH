import { z } from "zod";

/**
 * How a run ended, or that it has not (mvp spec §5.7); `cancelled` is deliberately distinct from `failed`, since an
 * operator stop is not the workflow breaking (§5.6).
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "awaiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RunStatusSchema = z.enum(RUN_STATUSES);

/** The three statuses a run can end on. A terminal run never moves again. */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const TerminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);

/** Whether a run is finished and can no longer be acted on — the one terminality check. */
export function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
