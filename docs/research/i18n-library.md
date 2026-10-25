# i18n library for the Viewer, the Designer, client-core and the server

Research for issue #801 (child of wayfinder map #795). Fetched 2026-10-25. Sources are the libraries' own docs, the npm registry, GitHub, and measurements made for this note. Claims I could not confirm in a primary source are marked **Unconfirmed**.

## Question

Which i18n approach fits PATH: a small hand-rolled catalogue plus `Intl`, i18next/react-i18next, Lingui, or FormatJS (react-intl)? Criteria: ICU plurals and parameters, use outside React, bundle size, a CI check that the `de`, `en` and `zh-CN` catalogues have the same keys, type-safe keys, maintenance in 2026, React 19 and Vite compatibility.

## Short answer

Use **`use-intl`** (the framework-agnostic core of next-intl, which AiBlocks already uses) with one ICU JSON catalogue per locale, `en` as the source copy.

1. It is FormatJS's ICU engine (`intl-messageformat`) behind the exact API and message format AiBlocks uses. The glossary, the key-parity test and the Claude drafting workflow carry over unchanged.
2. `createTranslator` and `createFormatter` from `use-intl/core` work in plain TypeScript with no provider, so `client-core` and `@path/server` can use the same catalogues as the React apps.
3. About 12 KB min+gzip, no build plugin, so nothing changes in the Vite 8 configs, and `client-core` (shipped as TS source) and the server (run with `tsx`) need no transform step.
4. Runner-up: FormatJS (`@formatjs/intl` + `react-intl`). Same engine, similar size, plus a `formatjs verify` CLI. It loses only because it does not match AiBlocks.
5. Rejected: i18next (not ICU by default; its plural keys differ per language, which breaks a plain key-parity check; ICU plugin brings it to ~30 KB gz). Lingui (needs a macro transform that neither `client-core` nor the `tsx`-run server gets). Hand-rolled (we would rewrite ICU plural/select by hand, or put translations in TS functions reviewers cannot edit).

## What PATH has today

- `packages/viewer` and `packages/designer`: React `^19.3.0`, Vite `^8.3.0`, `@vitejs/plugin-react` `^6.1.1`, TypeScript `^7.0.2`, Vitest 5. Plugins are only `react()` and `preloadClerk()`.
- `packages/client-core`: plain TypeScript, no build script. It is consumed as source through `exports` (`"./src/index.ts"`). It builds display strings, for example `eventMessage()` in `src/event-message.ts` (`while-do ${label} exited after ${n} iterations`, a plural) and the Resume-from refusal messages in `src/resume-from-eligibility.ts`.
- `packages/server`: Node, run from TS source with `tsx` (`bin/path-server.ts`). Server and engine errors are in scope for translation (map #795 Notes), so the library must run in Node with no bundler.
- The landing page (`packages/server/site/index.html`) has an inline dictionary from #800.

So any approach that depends on a bundler transform (Lingui macros) would work in the two Vite apps only.

## Reference: AiBlocks

`AiBlocks-repo` uses next-intl `^4.14.9`:

- `messages/{de,en,zh-CN}.json`, nested keys, ICU strings such as `"{count, plural, one {# component} other {# components}}"`.
- `global.d.ts` augments `AppConfig` with `Messages: typeof en` and `Locale`, so keys are type-checked against `en`.
- `messages/parity.test.ts` + `i18n/message-keys.ts`: a 20-line `keyDifferences(en, other)` over dotted leaf keys, run in Vitest. It reports `missing` and `extra` per locale.
- `docs/i18n-glossary.md`: one fixed term per concept per locale, reviewers named per language.

`use-intl` is the package next-intl builds on (next-intl `4.14.9` depends on `use-intl ^4.14.9`). Choosing it keeps both RheinWeg apps on one message format and one API.

## Comparison

| | Hand-rolled + `Intl` | i18next + react-i18next | Lingui | FormatJS (react-intl) | use-intl |
|---|---|---|---|---|---|
| Latest (npm, 2026-10-25) | n/a | i18next 26.5.10, react-i18next 17.1.8 | 6.10.1 | react-intl 12.1.5, @formatjs/intl 6.1.4 | 4.14.9 |
| ICU plurals and parameters | Only what we write | No by default (own `{{x}}` syntax, `_one`/`_other` key suffixes). ICU through `i18next-icu` | Yes (ICU, compiled at build time) | Yes (reference ICU implementation) | Yes (`intl-messageformat`) |
| Outside React | Yes | Yes (`i18next.t`) | Yes, but the `t` macro needs a transform | Yes (`createIntl`) | Yes (`createTranslator`, `createFormatter`) |
| Runtime size, min+gzip (measured) | ~0.2 KB | 14.2 KB core; 26.7 KB with ICU; 29.9 KB with React + ICU | 2.2 KB core; 4.2 KB with React | 13.0 KB core; 14.9 KB with React | 12.0 KB core; 12.5 KB with React |
| Key-parity CI check | tsc or a test | Harder: plural keys differ per language | `lingui check missing` (PO catalogues) | `formatjs verify --missing-keys --extra-keys --structural-equality` | 20-line test (as AiBlocks) |
| Type-safe keys | Yes, if catalogues are TS | Yes (`CustomTypeOptions`) | Ids come from source text, typing differs | Opt-in (`FormatjsIntl.MessageArguments`) | Yes (`AppConfig.Messages`) |
| Build step needed | No | No | Yes (macro transform via `@lingui/vite-plugin`) | No (optional extract/compile) | No |
| React 19 / Vite 8 | Yes | `react >= 16.8.0` | `react ^19.0.0` listed; Vite `^6.3 \|\| ^7 \|\| ^8` | `react >= 18.0.0` | `react ^19.0.0` listed |
| GitHub last push | n/a | 2026-10-24 | 2026-10-23 | 2026-10-25 | 2026-10-02 |
| npm weekly downloads | n/a | 15.2 M | 1.1 M (`@lingui/core`) | 1.9 M | 4.8 M |

Sizes: each library's public entry bundled with esbuild 0.28 (`--bundle --minify --format=esm`, React external), then `gzip -9`. This is the cost before any messages are added. Versions, peers and dates: `npm view <pkg>` and `gh api repos/<owner>/<repo>`. Downloads: `api.npmjs.org/downloads/point/last-week`.

## Notes per option

### Hand-rolled catalogue plus `Intl`

- Zero dependencies. `Intl.PluralRules`, `Intl.NumberFormat` and `Intl.DateTimeFormat` cover the locale rules.
- If catalogues are TS objects typed as `typeof en`, the compiler proves same keys for free (missing keys fail; excess keys in an object literal fail).
- Cost: either we write an ICU subset parser (plural, select, `#`, number) and its tests, or each plural message is a TS function. Functions are not something a German or Chinese reviewer can edit, and they do not fit the "Claude drafts, native speaker reviews" flow from the map Notes. It also splits from AiBlocks' JSON.

### i18next + react-i18next

- Plurals: [i18next plurals](https://www.i18next.com/translation-function/plurals) uses key suffixes from `Intl.PluralRules` categories (`_one`, `_other`, `_zero`, …), and "the variable must be named `count`". Chinese has only `other`, German and English have `one` and `other`. So `de.json` and `zh-CN.json` legitimately have different key sets, and the parity check must know CLDR plural categories per locale.
- ICU needs the `i18next-icu` plugin (2.6.1, peers `intl-messageformat >=10.3.3 <13`, ~476 k weekly downloads). With it, the bundle is about twice the size of use-intl or FormatJS, because both i18next and `intl-messageformat` ship.
- Types: [i18next TypeScript](https://www.i18next.com/overview/typescript) types keys through `CustomTypeOptions.resources`. Argument inference (`parseInterpolation: 'icu'`) "only works when resources come from a `.ts` file using `as const` or from a `d.ts` interface", not plain JSON. Large catalogues can slow `tsc`; the docs recommend `enableSelector: "optimize"`.
- Healthy project (one open issue on each repo, commits this week).

### Lingui

- Smallest runtime, because messages are compiled ahead of time ([Lingui CLI](https://lingui.dev/ref/cli): `lingui compile` writes minified JS/TS catalogues).
- Needs a transform: [Lingui installation](https://lingui.dev/installation) says Lingui "needs a transform step to convert its JS/JSX components into ICU MessageFormat and extract message IDs", for Vite via `lingui({ macroTransform: true })` from `@lingui/vite-plugin`. Vite 8 is supported. But `client-core` has no build of its own, and the server runs under `tsx` with no plugin, so the macro would not run there. Without macros Lingui is a plain id-to-message lookup and loses its main benefit.
- Default catalogue format is PO, not JSON. Message ids are usually extracted from source text. Both differ from AiBlocks.
- CI: `lingui check missing` fails on missing translations; `lingui compile --strict` fails when a catalogue still has missing translations after `fallbackLocales`.

### FormatJS (react-intl, @formatjs/intl, intl-messageformat)

- The reference ICU implementation. use-intl, next-intl and `i18next-icu` all run on its `intl-messageformat`.
- Outside React: [react-intl API](https://formatjs.github.io/docs/react-intl/api) `createIntl` builds an `IntlShape` with no provider; `createIntlCache` shares `Intl.*` constructors.
- CI: [formatjs CLI](https://formatjs.github.io/docs/tooling/cli) `formatjs verify --source-locale en --missing-keys --extra-keys --structural-equality` checks keys and that each translation keeps the source's placeholders. `formatjs compile` "needs a native binding" on the npm CLI (macOS arm64, Linux arm64/x64 glibc, Windows x64). Whether `verify` accepts AiBlocks-style nested JSON is **Unconfirmed**.
- Types: opt-in through `FormatjsIntl.MessageArguments` / `MessageArgumentsFromCatalog<typeof messages>`. Unregistered ids stay untyped.
- Very active (last push 2026-10-25).

### use-intl

- [Core library](https://next-intl.dev/docs/environments/core-library): `createTranslator({locale, messages})` and `createFormatter({locale})` from `use-intl/core` "receive all relevant configuration directly and don't rely on global configuration". `use-intl` "contains all APIs that are necessary for handling i18n in regular React apps" through `IntlProvider`, `useTranslations`, `useFormatter`. The page does not name Vite, but the package has no build plugin and only peers on React, so nothing Vite-specific is needed.
- Types: [TypeScript](https://next-intl.dev/docs/workflows/typescript) augments `AppConfig` with `Messages` and `Locale` (the AiBlocks `global.d.ts` pattern; `use-intl/dist/types/core/AppConfig.d.ts` holds the interface). ICU **argument** checks need a generated `en.d.json.ts`, which the docs produce with next-intl's Next.js plugin (`createMessagesDeclaration`). How to generate it without Next is **Unconfirmed**; key checks alone work without it.
- Missing messages: `onError` receives code `MISSING_MESSAGE`, and `getMessageFallback` decides what is shown (probe below). The English-fallback rule from #795 can be met by giving the translator `en` deep-merged under the active locale, while CI still fails on the gap.
- Maintenance: last push 2026-10-02, 55 open issues, 4.8 M weekly downloads. It moves at next-intl's pace, one maintainer-led project. This is the main risk, and it is shared with AiBlocks.

## Probe

`use-intl/core` 4.14.9 and `@formatjs/intl` 6.1.4 in plain Node 26, no React:

```
en     while-do L exited after 1 iteration | … after 1,234 iterations
de     while-do L nach 1 Durchlauf beendet | … nach 1.234 Durchläufen beendet
zh-CN  while-do L 在 1 次迭代后退出 | … 在 1234 次迭代后退出
dates  Oct 25, 2026, 3:00 PM | 25.10.2026, 15:00 | 2026年10月25日 15:00
missing key with onError + getMessageFallback → onError: MISSING_MESSAGE, "FALLBACK:onlyEn"
formatjs de  "3 Läufe", formatNumber(1234.5) → "1.234,5"
```

The `zh-CN` line shows a trap: a bare `{n}` outside a plural is not grouped. Write `{n, number}` when a number should follow the locale.

## Consequences for the open map questions

- **CI completeness check**: copy AiBlocks' `keyDifferences` test. To also catch a dropped placeholder (what `formatjs verify --structural-equality` does), compare the argument names of each message parsed with `@formatjs/icu-messageformat-parser`, which use-intl already pulls in.
- **Where catalogues live**: `client-core` and the server need the catalogues without React, so a shared location both can import is natural. That choice belongs to the key-naming ticket.
- **Landing page**: it can keep its inline dictionary or load the same JSON; use-intl does not force either.
