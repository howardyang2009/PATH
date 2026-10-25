import en from "../messages/en.json" with { type: "json" };
import type { Locale } from "./locale.js";

export type Messages = typeof en;

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}

/** The catalogue for `locale`. `en` is bundled as the runtime fallback; the others load lazily. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case "en":
      return en;
    case "de":
      return (await import("../messages/de.json", { with: { type: "json" } })).default;
    case "zh-CN":
      return (await import("../messages/zh-CN.json", { with: { type: "json" } })).default;
  }
}
