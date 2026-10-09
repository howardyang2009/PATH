export type Load<T> =
  | { phase: "loading" }
  /** A read that failed. `lastGood` carries the last value that landed, for a host that asked for
   * it (`useResource`'s `keepLastGood`); it is absent otherwise. */
  | { phase: "error"; message: string; lastGood?: T }
  | { phase: "ready"; value: T };

/** `PathApiError.message` carries the server's `{ error: { message } }` envelope; anything else is
 * stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
