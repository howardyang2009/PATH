import type { MessageKeys, NestedKeyOf } from "use-intl/core";
import type { Messages } from "./messages.js";

/** Every leaf key of the `en` catalogue. */
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

export type MessageParam = string | number | Message;

/** User-visible text as data: code outside React returns this, and the React layer renders it. */
export interface Message {
  key: MessageKey;
  params?: Record<string, MessageParam>;
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
