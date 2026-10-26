import {
  type AuthSession,
  PathApiClient,
  resolveLocale,
  startAuthSession,
} from "@path/client-core";
import { type Locale, loadMessages, type Messages } from "@path/i18n";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { createTranslator } from "use-intl/core";
import { z } from "zod";
import { AuthGate } from "./auth-gate.js";

/** Renders an app into `#root` behind the sign-in gate, in the page's Locale. Its API client uses
 * same-origin relative URLs (`/v0/...`), which the Vite proxy forwards in dev and `path-server`
 * serves in prod. */
export function mountApp(
  surface: "viewer" | "designer",
  app: (client: PathApiClient) => ReactNode,
): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing #root element");
  const root = createRoot(rootEl);
  const locale = resolveLocale({
    search: window.location.search,
    cookie: document.cookie,
    languages: navigator.languages,
  });
  document.documentElement.lang = locale;
  configureZod(locale);

  const render = (messages: Messages, auth?: AuthSession): void => {
    document.title = createTranslator({ locale, messages })(`${surface}.app.title`);
    const client = new PathApiClient({ baseUrl: "", ...auth?.clientAuth() });
    root.render(
      <StrictMode>
        <IntlProvider locale={locale} messages={messages}>
          {auth ? <AuthGate auth={auth}>{app(client)}</AuthGate> : app(client)}
        </IntlProvider>
      </StrictMode>,
    );
  };

  // The catalogue loads beside the auth session, so the first render is already in the Locale. An
  // unreadable auth config renders the app as local mode does, so its panes show the Server's own
  // errors; a hosted Server still refuses every unsigned call.
  const auth = startAuthSession({ baseUrl: "", location: window.location, locale }).catch(
    (error: unknown) => {
      console.error("cannot start sign-in", error);
      return undefined;
    },
  );
  // A catalogue chunk that fails to load leaves the app in English rather than blank.
  const messages = loadMessages(locale).catch((error: unknown) => {
    console.error("cannot load the catalogue", error);
    return loadMessages("en");
  });
  void Promise.all([messages, auth]).then(([messages, session]) => render(messages, session));
}

/** zod's built-in issue messages follow the Locale; `en` is zod's default. */
function configureZod(locale: Locale): void {
  if (locale === "de") z.config(z.locales.de());
  if (locale === "zh-CN") z.config(z.locales.zhCN());
}
