# Agent SDK Worker Verification Spike — Findings

**Issue:** #13 — empirically verify the three facts the [LLM worker execution options survey](llm-worker-execution-options.md) (#6) could not settle from primary sources.
**Date:** 2026-07-18.
**Setup:** macOS (arm64, 24 GB RAM), Node v22.23.1, `@anthropic-ai/claude-agent-sdk` **0.3.214** (it bundles a native Claude Code **2.1.214** binary via `@anthropic-ai/claude-agent-sdk-darwin-arm64`, about 247 MB on disk). The environment had **no** `ANTHROPIC_API_KEY` and **no** `CLAUDE_CODE_OAUTH_TOKEN`. The machine has an interactive `claude` subscription login. The scripts were throwaway, not committed. The observed outputs are reproduced below.

---

## 1. Subscription auth: the SDK picks it up — no CLI fallback needed

A plain `query()` with no API key **succeeded** under the user's existing Claude subscription login:

- `system/init` reported `apiKeySource: "none"`, and the query returned normally (`subtype: "success"`).
- Process sampling during the run caught the mechanism directly. The SDK subprocess executes
  `security find-generic-password -a <user> -w -s "Claude Code-credentials"`. That is, it reads the
  subscription OAuth credential from the **macOS keychain**, the same as the interactive CLI.

**Consequence for the spec:** the MVP worker does **not** need a headless-CLI fallback mode for
subscription users. The Agent SDK alone covers both auth paths (keychain OAuth when no key is present,
`ANTHROPIC_API_KEY` when set). Two standing caveats from the survey remain. (a) This behavior is
*undocumented*: the SDK docs only describe API-key/provider auth, so it can change without notice. (b)
Anthropic's policy forbids the *offering* of claude.ai login in a distributed third-party product. Both
are acceptable while PATH is a personal local tool. The message-shaped worker contract keeps the CLI
escape hatch open regardless.

## 2. Parallel sessions: one ~360 MB subprocess per processor, scales linearly

Streaming-input sessions (`prompt` as an `AsyncIterable`, the "one processor = one live session" shape)
spawn **one bundled-binary subprocess per session**. Concurrent sessions neither share nor multiplex a
subprocess.

| Concurrent sessions | Peak RSS per subprocess | Total subprocess RSS | All sessions warm (wall) |
|---|---|---|---|
| 1 | ~360 MB | ~0.36 GB | ~6 s (incl. spawn) |
| 4 | 358–365 MB | ~1.45 GB | ~4.5–5.5 s |
| 8 | 359–362 MB | ~2.9 GB | ~5.5 s |

- The per-subprocess footprint is flat (about 360 MB) regardless of fan-out. The engine-side Node
  process stayed at about 90 MB.
- Concurrent spawns do not serialize: 8 sessions all reached their first result within about 5.5 s,
  about the same as 4.
- Each session also briefly spawns a handful of short-lived helper processes (negligible RSS, reaped
  quickly).

**Consequence for the spec:** budget **about 400 MB of RAM per concurrent LLM processor**. A sane
default cap for parallel-block fan-out is **4 concurrent LLM-worker processors** (about 1.5 GB,
comfortable on 16 GB machines), overridable in engine config. The ceiling is memory, not CPU or spawn
latency. (This 24 GB machine ran 8 without strain.)

## 3. `total_cost_usd` under subscription auth: present, non-zero, an API-price estimate

The `result` message carries `total_cost_usd` under subscription auth, and it is **not** zero or absent:

- Cold first call (fresh system-prompt cache): `total_cost_usd ≈ $0.0948`. A ~15.7 K-token
  `cache_creation` write at 1 h TTL dominates it, per the accompanying `modelUsage` breakdown (per-model
  `costUSD`, token counts, cache read/write splits).
- Subsequent parallel sessions: about **$0.0053** each. The system-prompt cache is server-side per
  account, so every later session (including all members of a parallel fan-out) reads the cache the
  first call created.

So the field is a **client-side estimate at API list prices** of what the traffic *would* cost. Under
flat-rate subscription billing, nothing per-token is actually charged. `usage` and `modelUsage` report
real token counts either way.

**Consequence for the spec:** record `total_cost_usd` in run/audit records as `estimated_cost_usd` (an
API-equivalent estimate, accurate for API-key users, notional for subscription users), alongside raw
token usage, which is always real. The cache behavior also means parallel fan-out is about 18 times
cheaper per branch than the cold-start number suggests.

---

## Method notes (for re-running)

- One-shot test: `query({ prompt, options: { maxTurns: 1, settingSources: [] } })` with the credential
  env vars deleted; log the `system/init` and `result` messages.
- Parallel test: N streaming-input sessions held open after their first turn (a generator awaits a
  gate). Snapshot the process table every 300 ms and diff it against a pre-run baseline to catch the SDK
  subprocesses, which do not reliably show as direct children (the bundled binary re-execs from a bunfs
  extraction in `$TMPDIR/claude-<uid>`).
