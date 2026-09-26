export type Load<T> =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; value: T };

/** `PathApiError.message` carries the server's `{ error: { message } }` envelope; anything else is stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
