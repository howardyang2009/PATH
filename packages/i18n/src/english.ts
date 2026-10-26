import { createTranslator } from "use-intl/core";
import en from "../messages/en.json" with { type: "json" };
import { type Message, type MessageKey, renderMessage, type Translate } from "./message.js";

const translate = createTranslator({ locale: "en", messages: en }) as Translate;

/** `message` in English, for text that must read without a client: the wire's `message` fallback. */
export function englishText(message: Message): string {
  return renderMessage(translate, message);
}

/** `key` names a message of the `en` catalogue (a leaf, not a branch). */
export function isMessageKey(key: string): key is MessageKey {
  let node: unknown = en;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string";
}
