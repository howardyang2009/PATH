import type { MessageKeys, NestedKeyOf } from "use-intl/core";
import type { Messages } from "./messages.js";

/** Every leaf key of the `en` catalogue. */
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

export type MessageParam = string | number | Message;

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

/** Render `message` with `t`; a `Message` inside `params` is rendered first. */
export function renderMessage(t: Translate, message: Message): string {
  if (message.params === undefined) return t(message.key);
  const values = Object.fromEntries(
    Object.entries(message.params).map(([name, value]) => [
      name,
      typeof value === "object" ? renderMessage(t, value) : value,
    ]),
  );
  return t(message.key, values);
}
