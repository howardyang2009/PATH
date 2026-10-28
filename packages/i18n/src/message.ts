import type { MessageKeys, NestedKeyOf } from "use-intl/core";
import type { Messages } from "./messages.js";

/** Every leaf key of the `en` catalogue. */
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

/** A catalogue value: text, a number, a nested `Message`, or a list of them — a list is joined by
 * the Locale's own formatter, so German reads "a und b" where English reads "a and b". */
export type MessageParam = string | number | Message | readonly MessageParam[];

type CodeOf<K> = K extends `errors.${infer C}` ? C : never;

/** An ADR 0107 error code: the key of an `errors.<code>` message, without the namespace. */
export type ErrorCode = CodeOf<MessageKey>;

/** User-visible text as data: code outside React returns this, and the React layer renders it. */
export interface Message {
  key: MessageKey;
  params?: Record<string, MessageParam>;
}

/** Text PATH does not own (a server refusal, a parser error), carried as a `Message` unchanged. */
export function verbatim(text: string): Message {
  return { key: "shared.verbatim", params: { text } };
}

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** One Locale's way of turning a `Message` into text: its catalogue, and its list separator. */
export interface Rendering {
  t: Translate;
  /** Join already-rendered items the way the Locale writes a list. */
  list(items: readonly string[]): string;
}

/** Render `message` with `rendering`; a nested `Message` or a list in `params` renders first. */
export function renderMessage(rendering: Rendering, message: Message): string {
  if (message.params === undefined) return rendering.t(message.key);
  const values = Object.fromEntries(
    Object.entries(message.params).map(([name, value]) => [name, renderParam(rendering, value)]),
  );
  return rendering.t(message.key, values);
}

function renderParam(rendering: Rendering, value: MessageParam): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  if (isMessage(value)) return renderMessage(rendering, value);
  return rendering.list(value.map((item) => String(renderParam(rendering, item))));
}

function isMessage(value: MessageParam): value is Message {
  return !Array.isArray(value);
}
