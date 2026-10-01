# Server Zip Dependency Survey: fflate, archiver, yazl, Node built-ins

**Issue:** [#696](https://github.com/howardyang2009/PATH/issues/696), part of map [#693](https://github.com/howardyang2009/PATH/issues/693) (Designer Download button).
**Date:** 2026-10-01. Primary sources: npm registry metadata, GitHub repo metadata, upstream READMEs, Node.js docs. Each claim names its source. Install sizes were measured locally with `npm i`.

## Requirement

The Server builds one zip of a Workflow's transitive `ref` closure (store-relative paths kept) and streams or returns it. Inputs are small JSON files, a handful to tens of entries. Server is ESM (`"type": "module"` in `packages/server/package.json`), TypeScript, Node `>=24` (root `package.json` `engines`). Needs: zip write only, no read, no encryption.

## Comparison

| | fflate 0.8.3 | archiver 8.0.0 | yazl 3.3.1 | Node built-ins |
|---|---|---|---|---|
| License | MIT | MIT | MIT | Node core |
| Module format | ESM and CJS via `exports` (`node.import` -> `esm/index.mjs`) | `"type": "module"`, `exports: ./index.js` | CJS only (`main: index.js`, no `type`, no `exports`) | n/a |
| Own types | Yes (`esm/index.d.mts`) | No (no `types` field); needs `@types/archiver` 8.0.0 | No, needs `@types/yazl` 3.3.1 | n/a |
| `engines` | none declared | `node >=18` | none declared | n/a |
| Runtime deps | 0 | 9 direct (`async`, `buffer-crc32`, `is-stream`, `lazystream`, `normalize-path`, `readable-stream`, `readdir-glob`, `tar-stream`, `zip-stream`); `zip-stream` pulls `compress-commons` | 1 (`buffer-crc32`) | 0 |
| On disk (measured) | 828 KB (all build variants; `sideEffects: false`, tree-shakable) | 45 packages in `node_modules` | 68 KB | 0 |
| Streaming write | Yes: `Zip`, `ZipPassThrough`, `ZipDeflate`, `AsyncZipDeflate`; also one-shot `zipSync` / `zip` | Yes: Node stream, `append()`, `pipe()`, `finalize()` | Yes: `ZipFile.outputStream` is a Node Readable | `zlib` has deflate/gzip/brotli/zstd streams only, no PKZIP container |
| Zip64 | Files up to 4 GB per README comparison table | Via `zip-stream` / `compress-commons` | Automatic Zip64 for >4 GB or >65,534 entries | n/a |
| Last release | 2026-05-16 | 2026-05-08 | 2024-11-23 | n/a |
| Last push / open issues | 2026-05-16 / 46 | 2026-09-23 / 173 | 2026-03-14 / 20 | n/a |

Sources:
- fflate: <https://registry.npmjs.org/fflate> (version 0.8.3, license, exports map, `sideEffects`, no `engines`), <https://github.com/101arrowz/fflate> (README: stream classes, `zipSync`, 4 GB, "8kB" core), repo metadata via `gh api repos/101arrowz/fflate`.
- archiver: <https://registry.npmjs.org/archiver> (8.0.0, `type: module`, `engines`, deps list), <https://registry.npmjs.org/zip-stream> (7.0.5, deps), <https://github.com/archiverjs/node-archiver> (README: `import { ZipArchive } from "archiver"`).
- yazl: <https://registry.npmjs.org/yazl> (3.3.1, `main: index.js`, one dep), <https://github.com/thejoshwolfe/yazl> (README: `ZipFile`, `outputStream`, Zip64, O(1) open file handles), <https://registry.npmjs.org/@types/yazl>.
- Node: <https://nodejs.org/docs/latest-v24.x/api/zlib.html>. The module lists Gzip, Deflate/Inflate, Brotli and Zstd. `createUnzip()` auto-detects gzip/deflate, not PKZIP.

## Reading

- **archiver** is the most capable (globs, tar, directory walk) but we need none of that. Its 9 direct deps and about 45 installed packages are the largest supply-chain surface, and it has the most open issues. It is ESM-native, which is its one edge over yazl.
- **yazl** is tiny and stream-first, but CJS only and untyped. It needs `@types/yazl` and a default import under ESM. Last release is nearly two years old; the repo is still pushed to. Zero risk for a stable format, but it is the weakest on maintenance and ESM.
- **fflate** has zero runtime deps, ships ESM and types, is MIT, and covers both a sync one-shot (`zipSync`) and a streaming API. Disk size is mostly unused build variants; with `sideEffects: false` the code Node loads is small. It declares no `engines`, which is harmless on Node 24. It outputs Uint8Array, not Node streams. The Server can write chunks from the `Zip` `ondata` callback into the HTTP response.
- **Node built-ins** cannot produce a zip container. A hand-rolled writer is feasible: `zlib.deflateRawSync` plus `zlib.crc32` (present on this machine's Node 26.9; check the Node 24 docs before relying on it) plus local header, central directory and end record. It means about 60 lines of our own format code to test and own. Rejected: the issue wants one dependency, and a hand-written format writer is a poor trade for a small file count.

## Recommendation

**Use `fflate`.**

1. Fits the Server stack with no friction: ESM `exports`, bundled types, zero runtime dependencies, MIT.
2. The closure is a small set of JSON files held in memory. `zipSync` (or the streaming `Zip` class if we later stream) is enough. No Node stream plumbing needed.
3. Smallest supply-chain surface of the capable options (0 deps vs 9 and 1).
4. Releases are recent (2026-05).

Risks to check in the spec:
- Entry paths: fflate takes the key as the stored path. The builder must normalise to forward slashes and store-relative form itself, since fflate will not.
- Compression: set `level` explicitly. The inputs are small JSON, so any level is fine.
- Memory: it builds the zip in memory. Fine for a `ref` closure of small JSON. If closures could reach hundreds of MB, switch to the streaming `Zip` class or yazl.
- No `engines` field. Our own `engines` (`>=24`) governs.

Fallback if fflate is rejected: **yazl** (stream-first, one dep). Then add `@types/yazl`.
