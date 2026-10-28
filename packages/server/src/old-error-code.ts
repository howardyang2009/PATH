import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { codedMessage, type ErrorCode, englishErrorTemplates, type MessageParam } from "@path/i18n";
import type { LogEvent, StepFinishedEvent } from "@path/schema";

/** What one capture group yields: an argument's text, a plural's `#`, or a chosen option's value. */
type Capture =
  | { kind: "text"; name: string }
  | { kind: "count"; name: string }
  | { kind: "option"; name: string; value: string | number | undefined };

interface Pattern {
  code: ErrorCode;
  regex: RegExp;
  captures: Capture[];
  literalLength: number;
}

/** The value an option implies for its selector; a plural's `other` takes its value from `#`. */
function optionValue(type: TYPE, key: string): string | number | undefined {
  if (type === TYPE.select) return key;
  if (key === "one") return 1;
  return key.startsWith("=") ? Number(key.slice(1)) : undefined;
}

/** `template` as an anchored regex whose capture groups are described, in order, by `captures`. */
function compile(code: ErrorCode, template: string): Pattern {
  const captures: Capture[] = [];
  let literalLength = 0;
  const source = (elements: MessageFormatElement[], plural?: string): string =>
    elements
      .map((element) => {
        switch (element.type) {
          case TYPE.literal:
            literalLength += element.value.length;
            return element.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          case TYPE.argument:
            captures.push({ kind: "text", name: element.value });
            return "([\\s\\S]*?)";
          case TYPE.pound:
            captures.push({ kind: "count", name: plural ?? "" });
            return "(\\d+)";
          case TYPE.plural:
          case TYPE.select: {
            const options = Object.entries(element.options).map(([key, option]) => {
              const value = optionValue(element.type, key);
              captures.push({ kind: "option", name: element.value, value });
              const inner = element.type === TYPE.plural ? element.value : plural;
              return `(${source(option.value, inner)})`;
            });
            return `(?:${options.join("|")})`;
          }
          default:
            throw new Error(`errors.${code}: no regex for ICU element type ${element.type}`);
        }
      })
      .join("");
  const regex = new RegExp(`^${source(parse(template))}$`);
  return { code, regex, captures, literalLength };
}

// The most literal text first, so a specific template wins over a looser one that also matches.
const PATTERNS = englishErrorTemplates()
  .map(([code, template]) => compile(code, template))
  .sort((a, b) => b.literalLength - a.literalLength);

/**
 * The code and params of an English error written before codes existed (ADR 0107 point 5), matched
 * against the `en` catalogue; `undefined` when no template matches. An `error` param is decoded
 * again, since the engine nests a coded error there.
 */
export function oldErrorCode(
  error: string,
): { code: ErrorCode; params: Record<string, MessageParam> } | undefined {
  for (const { code, regex, captures } of PATTERNS) {
    const match = regex.exec(error);
    if (match === null) continue;
    const params: Record<string, MessageParam> = {};
    captures.forEach((capture, index) => {
      const text = match[index + 1];
      if (text === undefined) return;
      if (capture.kind === "text") params[capture.name] = textParam(capture.name, text);
      else if (capture.kind === "count") params[capture.name] = Number(text);
      else if (capture.value !== undefined) params[capture.name] = capture.value;
    });
    return { code, params };
  }
  return undefined;
}

function textParam(name: string, text: string): MessageParam {
  const nested = name === "error" ? oldErrorCode(text) : undefined;
  if (nested === undefined) return text;
  const { code, params } = nested;
  return codedMessage(code, Object.keys(params).length > 0 ? params : undefined);
}

/** `event` with the code of its old error, if it has one; the stored event is not changed. */
export function withOldErrorCode(event: LogEvent): LogEvent {
  if (event.type !== "step-finished" || event.error === undefined || event.error_code !== undefined)
    return event;
  const matched = oldErrorCode(event.error);
  if (matched === undefined) return event;
  const hasParams = Object.keys(matched.params).length > 0;
  return {
    ...event,
    error_code: matched.code,
    // A `Message` is plain JSON; the event schema types its params as JSON values.
    ...(hasParams ? { error_params: matched.params as StepFinishedEvent["error_params"] } : {}),
  };
}
