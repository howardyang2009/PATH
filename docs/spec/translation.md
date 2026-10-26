# PATH in German, English and Chinese

This spec is the hand-off for translating PATH into German (`de`), English (`en`) and Chinese
(`zh-CN`). It gathers the decisions of the wayfinder map
[#795](https://github.com/howardyang2009/PATH/issues/795). Each section links the ticket that holds
the full reasoning. Vocabulary is `CONTEXT.md` (**Locale**, **Error code**, and the
`## Translations` glossary). Error transport is
[ADR 0107](../adr/0107-errors-cross-the-wire-and-the-run-log-as-code-and-params.md).

Research: [i18n library](../research/i18n-library.md),
[string inventory](../research/string-inventory.md).

## 1. Scope

- **Translated:** the landing page (done in PR #800), the Viewer, the Designer, the display text
  `client-core` builds (event lines, Resume reasons, hints), server, engine and schema messages that
  reach the UI, and the Privacy and Terms pages.
- **Not translated:** content users write (workflow names, Step Template descriptions, form values),
  text PATH does not own (a worker's stderr, an exception from user code, an external API body), the
  CLI, server logs and stderr.
- **One switch.** The Locale is picked only on the landing page at `/`. The Viewer and the Designer
  have no language control; their brand link back to `/` is the way to change it.
- **About 800 strings** reach a user: Viewer ~130, Designer ~370, `client-core` ~27, server, engine
  and schema ~270, plus ~1750 words of legal text ([#802](https://github.com/howardyang2009/PATH/issues/802)).
- **Branch.** All work lands on `feat/landing-language-switch-795` (PR #800). PR #800 merges to `main`
  only when every build issue below is closed.

## 2. Library ([#801](https://github.com/howardyang2009/PATH/issues/801))

- `use-intl` (next-intl's framework-agnostic core, as in AiBlocks) with one ICU JSON catalogue per
  Locale. `en` is the source copy.
- React apps use `IntlProvider`, `useTranslations` and `useFormatter`. Plain TypeScript uses
  `createTranslator` / `createFormatter` from `use-intl/core`.
- No build plugin; the Vite configs do not change.

## 3. The `@path/i18n` package ([#807](https://github.com/howardyang2009/PATH/issues/807), [#808](https://github.com/howardyang2009/PATH/issues/808))

A new leaf package. The Viewer, the Designer, `client-core` and the server import it.

- **Catalogues:** `messages/de.json`, `messages/en.json`, `messages/zh-CN.json`. One file per Locale,
  not split by namespace.
- **Exports:**
  - `LOCALES` and `pickLocale(cookieValue, preferredLanguages)` (section 4);
  - `loadMessages(locale)`: `en` is a static import, `de` and `zh-CN` are `import()` chunks;
  - the `Messages` type and the use-intl `AppConfig` augmentation (`Messages: typeof en`, `Locale`),
    so a wrong key fails `pnpm typecheck`;
  - `Message = { key: MessageKey; params?: Record<string, string | number | Message> }`, where
    `MessageKey` is every key of the `en` catalogue;
  - `renderMessage(t, message)` and a `useMessage()` hook, which turn a `Message` into text and render
    nested `Message` params first.
- **Key shape:** `<namespace>.<component>.<name>`, camelCase, semantic, never the English sentence.
  Example: `viewer.runsList.cancelRun`.
- **Namespaces:** `viewer`, `designer`, `shared` (a key moves here only when a second app uses it),
  `events` (`client-core` display text), `errors` (ADR 0107 codes nested by their dots, kebab-case
  leaves kept: `errors.run.resume.illegal-k`).
- **Plurals and params:** a plural is one key with inline ICU
  (`{count, plural, one {# step} other {# steps}}`). `zh-CN` uses `other` only. Params have semantic
  camelCase names that match the code variable, and every Locale has the same param set.
- **Landing page:** keeps its inline dictionary in `packages/server/site/index.html`, outside the
  catalogues.

## 4. Locale resolution ([#806](https://github.com/howardyang2009/PATH/issues/806))

- **Cookie:** `RHEINWEG_LOCALE` on `.rheinwegde.de` (host-only on `localhost`), values `de` / `en` /
  `zh-CN`, shared with rheinwegde.de and AiBlocks. Only an explicit pick on the landing page writes it.
- **`pickLocale(cookieValue, preferredLanguages)`:**
  1. A valid cookie value wins. A value outside `LOCALES` is ignored.
  2. Otherwise walk the preferred languages in order; the first whose primary subtag is `de`, `zh` or
     `en` wins (`["fr", "de"]` gives `de`). Every `zh*` tag maps to `zh-CN`.
  3. Otherwise `en`.
  A fallback never writes the cookie.
- **`resolveLocale()`** in `@path/client-core` calls `pickLocale` with `document.cookie` and
  `navigator.languages`. A read-only `?lang=de|en|zh-CN` query parameter wins over both and is never
  written (for reviewers, screenshots and E2E tests).
- **Read once.** The Locale is read at load. No live switch, no polling.
- **`mountApp`** (Viewer and Designer):
  - waits for `Promise.all([startAuthSession, loadMessages(locale)])`, then renders inside one
    `IntlProvider`, so there is no flash of English;
  - sets `document.documentElement.lang` and `document.title` from the catalogue before the first
    render (`index.html` keeps `lang="en"` as the no-JS default);
  - calls `z.config(z.locales.de())` or `z.config(z.locales.zhCN())` for a non-`en` Locale;
  - passes `deDE` / `zhCN` from `@clerk/localizations` to `clerk.load({ localization })`.
- **Dates and numbers** follow the Locale. Every `toLocale*(undefined, …)` call gets the Locale
  explicitly: `useFormatter` inside React, a `locale` parameter in plain helpers such as
  `viewer/src/format-time.ts`. The time zone stays the browser's and the `h23` clock stays.

## 5. Text outside React ([#808](https://github.com/howardyang2009/PATH/issues/808))

- Code outside React returns a `Message` descriptor, never English text. This covers `client-core`
  (`eventMessage`, `resumeFromEligibility`, `blankSecretMessage`, `credentialHint`,
  `credentialPlaceholder`) and the Designer's `.ts` modules (`problems.ts`, `open-workflow.ts`,
  `condition-edit.ts`, `validated-draft.ts`, `session/save-plan.ts`, `interp-suggest.ts`,
  `document.ts`, `use-armed.ts`). The React layer renders it.
- A `Message` may nest in another's params, for example the `step-finished` line wrapping an error.
- Static tables hold keys, not text: `node-kind.ts` labels, blurbs and explanations, and `KIND_LABEL`
  in `problems-panel.tsx`. Node badges (`chip`: `CHECKPOINT`, `GOTO`, `LLM`, join labels) stay English.
- Event handlers inside React (the three `window.confirm` calls in `designer/src/app.tsx`) use `t`
  from `useTranslations()`.
- Code outside React that must produce final text with no React layer above it uses
  `createTranslator` with the Locale `mountApp` resolved. None exists today.

## 6. Errors ([#803](https://github.com/howardyang2009/PATH/issues/803), ADR 0107)

- **Wire shape:** `{ error: { code, params, message, details } }`. `replyError` / `sendError` take a
  code and params. `message` stays English as the fallback for an old client, `curl` and an unknown
  code.
- **Codes** are dotted kebab-case (`run.resume.illegal-k`). The catalogue key is `errors.<code>`. No
  mapping table.
- **The client localizes.** It renders `errors.<code>` with `params`; an unknown code shows `message`.
- **New run events:** the engine writes `error_code` and `error_params` next to the English `error`,
  inside the event JSON. The db schema version does not change.
- **Old run events:** when an event has no `error_code`, the server matches its `error` against
  regexes generated from the English catalogue (each ICU template becomes a regex whose captures are
  the params). The db is never rewritten. Text that matches no pattern is shown as stored. A test
  proves every code's English template round-trips through its regex.
- **Text PATH does not own** is shown verbatim inside a translated wrapper label.
- **zod:** built-in issues render through zod's own locale (section 4). PATH's own refinements in
  `@path/schema` put their code in `params: { code, …values }`. `zodIssueMessage(issue): Message`
  maps such an issue to a `Message`; an issue without `params.code` keeps zod's own message.
- **Operator text** (CLI, server logs, stderr) stays English.

## 7. Glossary and style ([#804](https://github.com/howardyang2009/PATH/issues/804))

- The `## Translations` section of `CONTEXT.md` fixes one `de` and one `zh-CN` term per concept. Use
  it in every catalogue and legal page.
- German keeps Workflow, Worker, Controller, Checkpoint, Secret, Trace and Plugin in English. Chinese
  translates every term. PATH, PATH Viewer and PATH Designer stay English.
- German uses "Sie". Chinese is Simplified, with full-width punctuation and a space between Chinese
  and Latin text or digits, and avoids 您.

## 8. Legal pages ([#805](https://github.com/howardyang2009/PATH/issues/805))

- **Files:** six hand-written static files `packages/server/site/{de,en,zh}/{privacy,terms}.html`.
  The current `privacy.html` and `terms.html` move to `en/`. No catalogue keys. Each file sets its own
  `<html lang>` and `<title>`.
- **German is binding.** Claude drafts German from the current English. The German reviewer checks the
  language, Han Yang approves the content. A lawyer checks the German before the first paying user.
  Han Yang reviews the Chinese.
- **Serving:** `SITE_PAGES` in `create-server.ts` gains the six `/<lang>/<page>` paths. Bare `/privacy`
  and `/terms` answer `302` with `Cache-Control: no-store` to `/<lang>/<page>`, where the language is
  `pickLocale(cookie, Accept-Language)`.
- **Courtesy note** in a box under the `<h1>`, on `en` and `zh` only:
  - en: "This is a courtesy translation. Only the [German version](/de/privacy) is legally binding."
  - zh: "本文为参考译文，仅[德文版本](/de/privacy)具有法律约束力。"
- **Language links:** a row "Deutsch · English · 中文" at the top links to the same page in the other
  languages; the current one is marked, not linked. These links do not write the cookie. Internal
  links stay in the same language. The back-link goes to `/`. The Impressum link stays
  `rheinwegde.de/de/impressum/`.
- **Privacy section 7** adds `RHEINWEG_LOCALE`: a language preference the user sets explicitly,
  strictly necessary under § 25(2) no. 2 TDDDG, kept 1 year, on `.rheinwegde.de`. All three versions
  carry the same "last updated" date and change in the same commit.

## 9. Drafting, review and CI ([#809](https://github.com/howardyang2009/PATH/issues/809))

- **Drafting.** Strings move by hand, one build slice at a time, with no extractor and no drafting
  script. The session that moves a slice writes `en`, `de` and `zh-CN` in the same commit, using the
  glossary. The English text moves verbatim; rewording is a separate commit.
- **All three together.** Every commit that adds an `en` key adds its `de` and `zh-CN` messages. A
  missing translation shows English at runtime, but CI fails first.
- **Changed English.** A commit that changes an `en` value updates `de` and `zh-CN` in the same commit
  and lists the changed keys in its PR text for re-review.
- **Review per build issue.** A build issue that adds catalogue text closes only after an approval
  comment from the `de` reviewer and one from the `zh-CN` reviewer. No per-key status.
- **Reviewers.** `zh-CN`: Liying Zhu. `de`: a native German speaker named by Han Yang, the same person
  who checks the German legal text. Both approve the `CONTEXT.md` glossary before any slice review.
- **CI.** One Vitest file in `@path/i18n`, run by the existing `pnpm test` step; no new job:
  1. `de` and `zh-CN` have exactly the keys of `en`;
  2. every message parses with `@formatjs/icu-messageformat-parser`;
  3. every message uses the same argument names as its `en` message;
  4. `de` plurals have `one` and `other`, `zh-CN` plurals have `other` only.
- **No automated glossary check.** The drafting session reads the glossary; the reviewer checks it.

## 10. Tests

- Unit tests of code outside React assert descriptors: `toEqual({ key, params })`.
- One `en` render test per surface proves the visible English is unchanged after a slice moves.
- `pickLocale` has one table test covering cookie, browser list order, `zh*` mapping and invalid
  cookie values.
- The ADR 0107 template-to-regex round-trip test lives in the server.

## 11. Build order

1. `@path/i18n` foundation (section 3, CI of section 9):
   [#810](https://github.com/howardyang2009/PATH/issues/810).
2. Locale wiring in `client-core`, the Viewer and the Designer (section 4):
   [#811](https://github.com/howardyang2009/PATH/issues/811).
3. In parallel after 2: Viewer strings ([#812](https://github.com/howardyang2009/PATH/issues/812)),
   Designer strings ([#813](https://github.com/howardyang2009/PATH/issues/813),
   [#814](https://github.com/howardyang2009/PATH/issues/814)), `client-core` display text
   ([#815](https://github.com/howardyang2009/PATH/issues/815)), the error-code wire and server
   refusals ([#816](https://github.com/howardyang2009/PATH/issues/816)).
4. After the wire: engine run-event codes ([#817](https://github.com/howardyang2009/PATH/issues/817)),
   then old-event matching ([#818](https://github.com/howardyang2009/PATH/issues/818)); schema
   validation codes ([#819](https://github.com/howardyang2009/PATH/issues/819)).
5. Legal pages after 1, because they need `pickLocale`
   ([#820](https://github.com/howardyang2009/PATH/issues/820)).
6. The glossary approval gates every review, not the build
   ([#821](https://github.com/howardyang2009/PATH/issues/821)).
7. PR #800 is marked ready when every build issue is closed
   ([#822](https://github.com/howardyang2009/PATH/issues/822)).
