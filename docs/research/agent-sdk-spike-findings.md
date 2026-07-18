# Agent SDK Worker Verification Spike — Findings

**Issue:** #13 — empirically verify the three facts the [LLM worker execution options survey](llm-worker-execution-options.md) (#6) could not settle from primary sources.
**Date:** 2026-07-18.
**Setup:** macOS (arm64, 24 GB RAM), Node v22.23.1, `@anthropic-ai/claude-agent-sdk` **0.3.214** (bundles a native Claude Code **2.1.214** binary via `@anthropic-ai/claude-agent-sdk-darwin-arm64`, ~247 MB on disk). Environment had **no** `ANTHROPIC_API_KEY` and **no** `CLAUDE_CODE_OAUTH_TOKEN`; the machine has an interactive `claude` subscription login. Throwaway scripts, not committed; observed outputs reproduced below.

---

## 1. Subscription auth: the SDK picks it up — no CLI fallback needed

A plain `query()` with no API key **succeeded** under the user's existing Claude subscription login:

- `system/init` reported `apiKeySource: "none"` and the query returned normally (`subtype: "success"`).
- Process sampling during the run caught the mechanism directly: the SDK subprocess executes
  `security find-generic-password -a <user> -w -s "Claude Code-credentials"` — i.e. it reads the
  subscription OAuth credential from the **macOS keychain**, same as the interactive CLI.

**Consequence for the spec:** the MVP worker does **not** need a headless-CLI fallback mode for subscription users; the Agent SDK alone covers both auth paths (keychain OAuth when no key is present, `ANTHROPIC_API_KEY` when set). Two standing caveats from the survey remain: (a) this behavior is *undocumented* — the SDK docs only describe API-key/provider auth — so it can change without notice; (b) Anthropic's policy forbids *offering* claude.ai login in a distributed third-party product. Both are acceptable while PATH is a personal local tool; the message-shaped worker contract keeps the CLI escape hatch open regardless.

## 2. Parallel sessions: one ~360 MB subprocess per processor, scales linearly

Streaming-input sessions (`prompt` as an `AsyncIterable`, the "one processor = one live session" shape) spawn **one bundled-binary subprocess per session**; concurrent sessions neither share nor multiplex a subprocess.

| Concurrent sessions | Peak RSS per subprocess | Total subprocess RSS | All sessions warm (wall) |
|---|---|---|---|
| 1 | ~360 MB | ~0.36 GB | ~6 s (incl. spawn) |
| 4 | 358–365 MB | ~1.45 GB | ~4.5–5.5 s |
| 8 | 359–362 MB | ~2.9 GB | ~5.5 s |

- Per-subprocess footprint is flat (~360 MB) regardless of fan-out; the engine-side Node process stayed at ~90 MB.
- Concurrent spawns do not serialize: 8 sessions all reached their first result within ~5.5 s, about the same as 4.
- Each session also briefly spawns a handful of short-lived helper processes (negligible RSS, reaped quickly).

**Consequence for the spec:** budget **~400 MB of RAM per concurrent LLM processor**. A sane default cap for parallel-block fan-out is **4 concurrent LLM-worker processors** (~1.5 GB — comfortable on 16 GB machines), overridable in engine config; the ceiling is memory, not CPU or spawn latency. (This 24 GB machine ran 8 without strain.)

## 3. `total_cost_usd` under subscription auth: present, non-zero, an API-price estimate

The `result` message carries `total_cost_usd` under subscription auth, and it is **not** zero or absent:

- Cold first call (fresh system-prompt cache): `total_cost_usd ≈ $0.0948` — dominated by a ~15.7 K-token `cache_creation` write at 1 h TTL, per the accompanying `modelUsage` breakdown (per-model `costUSD`, token counts, cache read/write splits).
- Subsequent parallel sessions: ≈ **$0.0053** each — the system-prompt cache is server-side per account, so every later session (including all members of a parallel fan-out) reads the cache the first call created.

So the field is a **client-side estimate at API list prices** of what the traffic *would* cost — under flat-rate subscription billing nothing per-token is actually charged. `usage` and `modelUsage` report real token counts either way.

**Consequence for the spec:** record `total_cost_usd` in run/audit records as `estimated_cost_usd` (an API-equivalent estimate, accurate for API-key users, notional for subscription users), alongside raw token usage which is always real. The cache behavior also means parallel fan-out is ~18× cheaper per branch than the cold-start number suggests.

---

## Method notes (for re-running)

- One-shot test: `query({ prompt, options: { maxTurns: 1, settingSources: [] } })` with credential env vars deleted; log `system/init` and `result` messages.
- Parallel test: N streaming-input sessions held open after their first turn (generator awaiting a gate); process table snapshotted every 300 ms and diffed against a pre-run baseline to catch the SDK subprocesses, which do not reliably show as direct children (the bundled binary re-execs from a bunfs extraction in `$TMPDIR/claude-<uid>`).
