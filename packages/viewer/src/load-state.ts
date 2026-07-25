/**
 * The three states every read surface in the pane is in: fetching, failed, or holding a value.
 * Shared so the runs list and the run detail describe loading the same way — and so the error
 * message is derived the same way, whatever the client threw.
 */
export type Load<T> = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; value: T };

/** `PathApiError.message` carries the server's `{ error: { message } }` envelope; anything else is stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
