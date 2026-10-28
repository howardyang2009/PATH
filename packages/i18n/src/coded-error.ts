import { englishText, isMessageKey } from "./english.js";
import { type ErrorCode, type Message, type MessageParam, verbatim } from "./message.js";

export type ErrorParams = Record<string, MessageParam>;

/** An error PATH owns (ADR 0107): the code the client renders from its catalogue, and its params. */
export interface CodedError {
  code: ErrorCode;
  params?: ErrorParams;
}

/** The `Message` of the error `code`: the catalogue's `errors.<code>` with `params`. */
export function codedMessage(code: ErrorCode, params?: ErrorParams): Message {
  return { key: `errors.${code}`, ...(params ? { params } : {}) };
}

/** The English text of the error `code`, for the CLI, logs and the wire's `message` fallback. */
export function errorText(code: ErrorCode, params?: ErrorParams): string {
  return englishText(codedMessage(code, params));
}

/** The code of an `errors.*` message, or `undefined` for any other message. */
export function errorCodeOf(message: Message): CodedError | undefined {
  if (!message.key.startsWith("errors.")) return undefined;
  const code = message.key.slice("errors.".length) as ErrorCode;
  return message.params === undefined ? { code } : { code, params: message.params };
}

/**
 * A coded error read back from the wire, a run event or an issue: the catalogue's message for a
 * code this catalogue knows, else `fallback` shown as is (an old server, an old event, ajv's text).
 */
export function decodeError(code: unknown, params: unknown, fallback: string): Message {
  if (typeof code !== "string" || !isMessageKey(`errors.${code}`)) return verbatim(fallback);
  const values =
    typeof params === "object" && params !== null ? (params as ErrorParams) : undefined;
  return codedMessage(code as ErrorCode, values);
}
