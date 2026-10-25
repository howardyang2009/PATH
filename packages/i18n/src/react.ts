import { useTranslations } from "use-intl";
import { type Message, renderMessage } from "./message.js";

/** A renderer for `Message` descriptors in the active Locale; call inside an `IntlProvider`. */
export function useMessage(): (message: Message) => string {
  const t = useTranslations();
  return (message) => renderMessage(t, message);
}
