import { apiErrorMessage } from "@path/client-core";
import type { Message } from "@path/i18n";

export type Load<T> =
  | { phase: "loading" }
  /** A read that failed. `lastGood` carries the last value that landed, for a host that asked for
   * it (`useResource`'s `keepLastGood`); it is absent otherwise. */
  | { phase: "error"; message: Message; lastGood?: T }
  | { phase: "ready"; value: T };

/** A failure as the UI shows it: the server's error code from the catalogue, else its English
 * text (see `apiErrorMessage`). */
export function errorMessage(error: unknown): Message {
  return apiErrorMessage(error);
}
