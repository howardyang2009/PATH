import {
  codedMessage,
  decodeError,
  type ErrorCode,
  type ErrorParams,
  errorCodeOf,
  errorText,
  type Message,
  type MessageParam,
} from "@path/i18n";
import type { z } from "zod";

export { codedMessage };

/**
 * The body of a zod issue PATH owns (ADR 0107 point 7): `message` in English for the CLI and logs,
 * `params` with the code and values the client renders from its catalogue.
 */
export function codedIssue(
  code: ErrorCode,
  params?: ErrorParams,
): { message: string; params: { code: ErrorCode } & ErrorParams } {
  return { message: errorText(code, params), params: { code, ...params } };
}

/** {@link codedIssue} for a `codedMessage` a shared check returned. */
export function messageIssue(message: Message): ReturnType<typeof codedIssue> {
  const coded = errorCodeOf(message);
  if (coded === undefined) throw new Error(`not an error code: ${message.key}`);
  return codedIssue(coded.code, coded.params);
}

/**
 * An error map's text for `message`. zod keeps only the text an error map returns, but copies the
 * raw issue's own keys into the final issue, so the code rides there as `params`.
 */
export function codedErrorMap(rawIssue: object, message: Message): string {
  const { message: text, params } = messageIssue(message);
  (rawIssue as { params?: unknown }).params = params;
  return text;
}

/** A zod issue as a `Message`: a PATH refinement by its code, a built-in issue by zod's own text. */
export function zodIssueMessage(issue: z.core.$ZodIssue): Message {
  const { code, ...values } = (issue as { params?: Record<string, MessageParam> }).params ?? {};
  return decodeError(code, Object.keys(values).length > 0 ? values : undefined, issue.message);
}

/** One `Message` per issue, prefixed with the dot-path of the offending field. */
export function issueMessages(error: z.ZodError): Message[] {
  return error.issues.map((issue) => {
    const message = zodIssueMessage(issue);
    const path = issue.path.join(".");
    return path ? { key: "shared.issueAtPath", params: { path, issue: message } } : message;
  });
}
