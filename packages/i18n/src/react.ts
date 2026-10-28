import { useMemo } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { type Message, type Rendering, renderMessage } from "./message.js";

/** A renderer for `Message` descriptors in the active Locale; call inside an `IntlProvider`. */
export function useMessage(): (message: Message) => string {
  const t = useTranslations();
  const format = useFormatter();
  return useMemo(
    () => (message: Message) =>
      renderMessage({ t, list: (items) => format.list(items) } satisfies Rendering, message),
    [t, format],
  );
}
