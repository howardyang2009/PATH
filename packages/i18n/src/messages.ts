// Puts `use-intl` in every importer's program, so the augmentation below resolves there too.
import type {} from "use-intl";
import en from "../messages/en.json" with { type: "json" };
import type { Locale } from "./locale.js";

export type Messages = typeof en;

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}

/** The catalogue for `locale`. `en` is bundled as the runtime fallback; the others load lazily,
 * through a module of their own because Vite's dev server serves a JSON `import()` as script. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case "en":
      return en;
    case "de":
      return (await import("./catalogues/de.js")).messages;
    case "zh-CN":
      return (await import("./catalogues/zh-CN.js")).messages;
  }
}
