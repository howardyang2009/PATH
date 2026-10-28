import { createTranslator } from "use-intl/core";
import en from "../messages/en.json" with { type: "json" };
import {
  type ErrorCode,
  type Message,
  type MessageKey,
  type Rendering,
  renderMessage,
  type Translate,
} from "./message.js";

const translate = createTranslator({ locale: "en", messages: en }) as Translate;
const englishList = new Intl.ListFormat("en", { type: "conjunction" });

/** The English rendering, for text that must read without a client (the wire fallback, logs). */
export const englishRendering: Rendering = {
  t: translate,
  list: (items) => englishList.format(items),
};

/** `message` in English, for text that must read without a client: the wire's `message` fallback. */
export function englishText(message: Message): string {
  return renderMessage(englishRendering, message);
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

/** Every `errors.<code>` message of the `en` catalogue as its code and ICU template. */
export function englishErrorTemplates(): [ErrorCode, string][] {
  const templates: [ErrorCode, string][] = [];
  const visit = (node: object, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === "string") templates.push([`${prefix}${name}` as ErrorCode, value]);
      else visit(value, `${prefix}${name}.`);
    }
  };
  visit(en.errors, "");
  return templates;
}
