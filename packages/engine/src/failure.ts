import {
  type CodedError,
  codedMessage,
  type ErrorCode,
  type ErrorParams,
  englishText,
  errorCodeOf,
  errorText,
  type Message,
} from "@path/i18n";

/**
 * A failure PATH owns (ADR 0107): `errorMessage` is what the client renders from its catalogue,
 * `error` the same text in English for the CLI, logs and an old client.
 */
export interface Failure {
  error: string;
  errorMessage: Message;
}

export function failure(code: ErrorCode, params?: ErrorParams): Failure {
  return described(codedMessage(code, params));
}

/** A {@link Failure} for a `Message` already built, e.g. a `verbatim` one. */
export function described(errorMessage: Message): Failure {
  return { error: englishText(errorMessage), errorMessage };
}

/** A refusal PATH owns: the code and params the wire carries (ADR 0107 point 2). */
export interface CodedRefusal extends CodedError {
  params: ErrorParams;
  /** English, for the CLI. */
  message: string;
}

export function refusal(code: ErrorCode, params: ErrorParams): CodedRefusal {
  return { code, params, message: errorText(code, params) };
}

/** The event fields of a failure (ADR 0107 point 4): a code only for an `errors.*` message. */
export function errorEventFields(failure: Partial<Failure>): {
  error?: string;
  error_code?: string;
  error_params?: ErrorParams;
} {
  if (failure.error === undefined) return {};
  const coded = failure.errorMessage && errorCodeOf(failure.errorMessage);
  if (coded === undefined) return { error: failure.error };
  return {
    error: failure.error,
    error_code: coded.code,
    ...(coded.params ? { error_params: coded.params } : {}),
  };
}
