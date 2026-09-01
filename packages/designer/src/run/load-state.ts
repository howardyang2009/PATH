/**
 * The three states every run read surface is in: fetching, failed, or holding a value. The Designer
 * authors its own copy (ADR 0025: the `Load<T>` phase union and hook wiring stay per-surface, the React
 * binding of the already-shared `connectRunViewModel`, not logic). The error message is derived the same
 * way whatever the client threw — `PathApiError.message` already carries the server's envelope.
 */
export type Load<T> = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; value: T };

/** `PathApiError.message` carries the server's `{ error: { message } }` envelope; anything else is stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
