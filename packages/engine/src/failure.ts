import { type ErrorCode, englishText, type Message, type MessageParam } from "@path/i18n";

/**
 * A failure PATH owns (ADR 0107): `errorMessage` is what the client renders from its catalogue,
 * `error` the same text in English for the CLI, logs and an old client.
 */
export interface Failure {
  error: string;
  errorMessage: Message;
}

export function failure(code: ErrorCode, params?: Record<string, MessageParam>): Failure {
  return described({ key: `errors.${code}`, ...(params ? { params } : {}) });
}

/** A {@link Failure} for a `Message` already built, e.g. a `verbatim` one. */
export function described(errorMessage: Message): Failure {
  return { error: englishText(errorMessage), errorMessage };
}

/** A refusal PATH owns: the code and flat params the wire carries (ADR 0107 point 2). */
export interface CodedRefusal {
  code: ErrorCode;
  params: Record<string, string | number>;
  /** English, for the CLI. */
  message: string;
}

export function refusal(code: ErrorCode, params: Record<string, string | number>): CodedRefusal {
  return { code, params, message: englishText({ key: `errors.${code}`, params }) };
}

/** The event fields of a failure (ADR 0107 point 4): a code only for an `errors.*` message. */
export function errorEventFields(failure: Partial<Failure>): {
  error?: string;
  error_code?: string;
  error_params?: Record<string, MessageParam>;
} {
  if (failure.error === undefined) return {};
  const message = failure.errorMessage;
  if (message === undefined || !message.key.startsWith("errors.")) return { error: failure.error };
  return {
    error: failure.error,
    error_code: message.key.slice("errors.".length),
    ...(message.params ? { error_params: message.params } : {}),
  };
}
