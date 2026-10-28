import type { Message } from "@path/i18n";
import { isTerminal, type RunStatus } from "@path/schema";
import {
  type ResumeFromEligibility,
  type ResumeFromEligibilityArgs,
  resumeFromEligibility,
} from "./resume-from-eligibility.js";

/** A run that still has work in flight: a root with a parked leaf reads `awaiting` (ADR 0038). */
export function isInFlight(status: RunStatus): boolean {
  return status === "running" || status === "awaiting";
}

/** Whether an operator may cancel a run: every status but the three terminal ones. */
export function isCancellable(status: RunStatus): boolean {
  return !isTerminal(status);
}

/** Whether the leaf is parked on a person; only that leaf shows Complete (ADR 0042). */
export function isAwaiting(status: RunStatus): boolean {
  return status === "awaiting";
}

/** The plain `Resume run` button: shown on every terminal row, enabled only where Resume is
 * legal (`cancelled`/`failed`); a `succeeded` row shows it greyed with its reason. */
export interface RunResumeAction {
  show: boolean;
  enabled: boolean;
  reason: Message | null;
}

/** `Resume from …` (ADR 0033): shown only for the watched run, enabled only when its K is legal. */
export interface RunResumeFromAction {
  show: boolean;
  enabled: boolean;
}

export interface RunRowActionsInput {
  /** The row's stored status. */
  status: RunStatus;
  /** The server's display status — a root with a parked leaf reads `awaiting` (ADR 0038). */
  displayStatus: RunStatus;
  /** The eager legal-K facts when this row is the watched run's root; `null` for any other row
   * and while its tree is not loaded. */
  resumeFrom: ResumeFromEligibilityArgs | null;
}

export interface RunRowActions {
  /** No verb is offered: a live run cannot be resumed, and the server 409s a delete on it. */
  inFlight: boolean;
  resume: RunResumeAction;
  resumeFrom: RunResumeFromAction;
  /** The legal-K verdict `Resume from …` renders; `null` while its door is shut. */
  eligibility: ResumeFromEligibility | null;
  delete: { show: boolean };
}

/**
 * What a run row offers, decided once: a live run offers nothing, a finished run offers Delete
 * plus the Resume verbs its status and K allow (ADR 0033). The Viewer's rail and the Designer's
 * run dock read this same value.
 */
export function runRowActions(input: RunRowActionsInput): RunRowActions {
  const { status, displayStatus, resumeFrom } = input;
  const inFlight = isInFlight(displayStatus);

  const showResume = isTerminal(status);
  const resumeEnabled = status === "cancelled" || status === "failed";
  const resume: RunResumeAction = {
    show: showResume,
    enabled: showResume && resumeEnabled,
    reason: showResume && !resumeEnabled ? { key: "shared.resumeActions.succeededReason" } : null,
  };

  const eligibility = resumeFrom !== null && !inFlight ? resumeFromEligibility(resumeFrom) : null;

  return {
    inFlight,
    resume,
    resumeFrom: { show: eligibility !== null, enabled: eligibility?.ok === true },
    eligibility,
    delete: { show: !inFlight },
  };
}
