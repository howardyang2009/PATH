# LLM Worker Execution Options Survey

**Issue:** #6 — how should a "subagent + LLM" worker execute a **prompt + context** step?
**Scope:** macOS-first, TypeScript engine on Node LTS. Terms per `CONTEXT.md`: a *worker* is the execution binding of a step; a *processor* is one live worker instance (for example, an LLM chat session); *config* flows in from outside, *context* is written from inside the run.
**Date:** 2026-07-17. Primary sources only; each claim carries its source URL. All Claude Code / Agent SDK claims are against the current docs (Claude Code ~v2.1.2xx).

---

## TL;DR & Recommendation

**Use the Claude Agent SDK (TypeScript, `@anthropic-ai/claude-agent-sdk`) as the MVP's LLM worker
mechanism**, with the headless CLI (`claude -p`) understood as the same harness reached over argv/stdout
instead of a typed API.

Tested against PATH's needs:

| PATH need | Agent SDK answer |
|---|---|
| Engine spawns workers per step | `query()` is one call per step; the SDK spawns and manages a bundled Claude Code subprocess itself — no argv assembly, no NDJSON parsing, no PATH-managed child processes. ([overview](https://code.claude.com/docs/en/agent-sdk/overview), [typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript)) |
| Long-lived "LLM chat session" processor | Session IDs + `resume` / `forkSession` / streaming-input mode map directly onto PATH's *processor* concept: one processor = one SDK session, fed multiple steps. ([sessions](https://code.claude.com/docs/en/agent-sdk/overview)) |
| Structured output capture | `outputFormat: { type: 'json_schema', schema }` gives schema-validated step output; result messages carry `session_id`, `usage`, `total_cost_usd`. ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript)) |
| MCP/skills as worker config, not step types | `mcpServers`, `allowedTools`, `skills`, `agents`, `settingSources` are all **options on the worker invocation** — exactly the "capabilities ride along on the worker" model the step-type decision requires. |
| Multi-platform door open | SDK runs wherever Claude Code runs (macOS/Linux/Windows); the underlying child process is an implementation detail behind a TS API, so a future remote worker can swap in the same message protocol over IPC/HTTP. |

**Two deliberate hedges:**

1. **Keep the worker interface message-shaped, not SDK-shaped.** The headless CLI's `stream-json`
   protocol and the SDK's `SDKMessage` stream are the same wire format. If PATH's worker contract is
   "stream of messages in, result message out," the CLI (for subscription-auth users or non-Node
   contexts) and a future remote runner are drop-in alternates.
2. **For trivial single-shot prompt steps** (classification, extraction, judge-steps) the direct
   Anthropic API (`@anthropic-ai/sdk`) is cheaper per invocation (no harness system prompt, no
   subprocess) and is worth adding later as a second, lighter worker type (`llm-call` vs `subagent`). It
   is *not* the MVP pick, because it makes PATH own the agentic loop, tool execution, and the MCP/skills
   plumbing that the Agent SDK provides for free.

Local runtimes (Ollama et al.) are a fallback/offline worker type only. They are viable because they
expose stable localhost HTTP APIs with JSON-schema output, but with no first-party MCP/skills story
(except LM Studio's) and no agent harness.

---

## Option 1 — Claude Code CLI, headless (`claude -p`)

Claude Code's non-interactive mode: pass `-p` / `--print` plus any CLI option. The docs now frame this
as "the Agent SDK via the CLI." It is recommended for "other languages"; Anthropic's own guidance for
TS/Python is to use the SDK packages instead.
([headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference))

### Session lifecycle

- **One process per invocation.** Each `claude -p` run is a fresh OS process that exits after the
  result. Conversation state persists **on disk** between invocations, so a "session" survives across
  processes:
  - `--continue` / `-c` — continue the most recent conversation in the current directory.
  - `--resume <session-id>` / `-r` — continue a specific session; capture the ID from JSON output:
    `session_id=$(claude -p "..." --output-format json | jq -r '.session_id')`. Session lookup is scoped
    to the project directory and its git worktrees.
  - `--session-id <uuid>` — pin a specific session ID; `--fork-session` — resume into a new ID;
    `--no-session-persistence` — disable disk persistence (print mode only).
  - So a PATH *processor* is a session ID; to feed it multiple steps is one process spawn per step with
    `--resume`. There is no way to hold a single warm process and push multiple turns into it **except**
    `--input-format stream-json`, which accepts newline-delimited user messages on stdin. That *is* a
    long-lived multi-turn process, and it is exactly what the Agent SDK drives under the hood.
- **Startup cost:** non-trivial — a full Node/CLI boot per invocation plus auto-discovery of hooks,
  skills, plugins, MCP servers, memory, and CLAUDE.md. `--bare` skips all auto-discovery "so scripted
  calls start faster" and is "the recommended mode for scripted and SDK calls, and will become the
  default for `-p` in a future release." ([headless](https://code.claude.com/docs/en/headless))
  Background bash tasks are killed about 5 s after the result; background subagents are awaited (capped
  at 10 min by default through `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).

### Context injection

- **Prompt:** argv (`claude -p "<prompt>"`) and/or **stdin pipe** (`cat build-error.txt | claude -p
  '...'`). Piped stdin is capped at 10 MB (v2.1.128+); larger inputs must be written to a file and
  referenced by path, which suits PATH's context-directory model well.
- **System prompt:** `--system-prompt` / `--system-prompt-file` (replace) and `--append-system-prompt` /
  `--append-system-prompt-file` (append to the Claude Code default).
- **Files/workspace:** the run's `cwd` is the workspace; `--add-dir` grants additional directories. PATH
  can materialize step input plus shared context into the run directory and let the worker Read it.
- **Settings/config:** `--settings <file-or-json>` (session-scoped settings override),
  `--setting-sources user,project,local`, `--agents <json>` (inline subagent definitions), `--env` through
  process environment.

### Output capture

- `--output-format text | json | stream-json`. ([headless](https://code.claude.com/docs/en/headless))
  - `json`: single object with `result` (text), `session_id`, `usage`, and `total_cost_usd` **plus a
    per-model cost breakdown**.
  - `json` + `--json-schema '<JSON Schema>'`: schema-validated structured output in a `structured_output`
    field (invalid schemas exit with an error as of v2.1.205).
  - `stream-json` (+ `--verbose`, optionally `--include-partial-messages`): NDJSON event stream —
    `system/init` (model, tools, MCP servers, capabilities array for feature detection),
    `assistant`/`user` messages (subagent messages tagged with `parent_tool_use_id`), `system/api_retry`
    events with typed error categories (`rate_limit`, `billing_error`, `overloaded`, and so on), and a
    final `result` message with text, cost, and session metadata.
- **Error signaling:** non-zero exit status on failure (for example, stdin cap exceeded, invalid
  `--json-schema`; `--max-turns` limit reached exits with an error). Retryable API errors surface as
  `system/api_retry` events before the CLI retries.
- **Run limits:** `--max-turns N` and `--max-budget-usd X` (both print-mode only), direct hooks for
  PATH-level guardrails.

### Cost & auth

- **Auth:** either an interactive `claude` login credential (Claude Pro/Max subscription OAuth, stored
  in the keychain) or `ANTHROPIC_API_KEY` (also Bedrock/Vertex/Foundry provider credentials). `--bare`
  **skips OAuth and keychain reads**; auth must then come from `ANTHROPIC_API_KEY` or an `apiKeyHelper`
  in `--settings`. ([headless](https://code.claude.com/docs/en/headless)) Some flags are API-key-only
  (for example, `--betas`). ([cli-reference](https://code.claude.com/docs/en/cli-reference))
- **Billing:** subscription login is flat monthly with usage limits; API key is standard per-token API
  billing. Per-invocation cost reporting is built in (`total_cost_usd` in `json` output;
  `--max-budget-usd` cap).

### MCP servers & skills as worker-side configuration

This maps cleanly onto PATH's "capabilities ride along on the worker" decision:

- **MCP:** `--mcp-config <files-or-json>` loads servers per invocation; `--strict-mcp-config` ignores
  every other MCP source. Together they make MCP servers pure worker config, deterministic per step.
  Ambient sources otherwise: project `.mcp.json` (version-controllable, shared), `~/.claude.json`
  (local/user scopes). Config shape: `{"mcpServers": {"name": {"command": ..., "args": [...], "env":
  {...}}}}` for stdio, `{"type": "http" | "sse" | "ws", "url": ...}` for remote. Tools are named
  `mcp__<server>__<tool>` and are allow-listed with the same `--allowedTools` permission-rule syntax as
  built-ins. ([mcp](https://code.claude.com/docs/en/mcp))
- **Tools/permissions:** `--allowedTools "Bash(git diff *),Read,Edit"`, `--disallowedTools`, `--tools`,
  `--permission-mode` (`acceptEdits`, `dontAsk`, `bypassPermissions`, and so on),
  `--permission-prompt-tool` (delegate approval to an MCP tool, a hook for a future PATH approval UI).
- **Skills:** filesystem-based (`.claude/skills/*/SKILL.md`); auto-discovered unless `--bare`.
  User-invoked skills work in `-p` mode by inclusion of `/skill-name` in the prompt string. So skills are
  worker config through the workspace's `.claude/` directory (or a plugin through `--plugin-dir`).
  ([headless](https://code.claude.com/docs/en/headless), [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview))

### Fit for PATH

- **Process model:** child process per step (`spawn`), stdout NDJSON parsing. Works from any language,
  the door-opener property.
- **Downsides for a TS engine:** you re-implement what the SDK ships (typed messages, error objects,
  streaming-input session management; hooks/`canUseTool` callbacks are unavailable); per-invocation boot
  cost unless `--bare`; version skew between engine and whatever `claude` binary is on the user's PATH.
- **Upside unique to the CLI:** it inherits the user's **subscription login**, no API key required for a
  personal tool.

---

## Option 2 — Claude Agent SDK (TypeScript)

`@anthropic-ai/claude-agent-sdk` — "the same tools, agent loop, and context management that power Claude
Code, programmable in Python and TypeScript."
([overview](https://code.claude.com/docs/en/agent-sdk/overview))

### Session lifecycle

- **Process model:** the SDK is a library in your Node process that **spawns and manages a Claude Code
  subprocess**. The TS package "bundles a native Claude Code binary for your platform as an optional
  dependency, so you don't need to install Claude Code separately."
  ([overview](https://code.claude.com/docs/en/agent-sdk/overview)) `executable: 'node' | 'bun' | 'deno'`
  and `pathToClaudeCodeExecutable` are overridable.
  ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript))
- **One-shot:** `query({ prompt, options })` returns an async generator of `SDKMessage`s; iteration ends
  with a `result` message. One `query()` is one run.
- **Long-lived processor:** three mechanisms:
  1. **Streaming input mode:** pass an `AsyncIterable<SDKUserMessage>` as `prompt`. The subprocess stays
     alive across turns, and the returned `Query` object exposes mid-session controls
     (`setPermissionMode`, `setModel`, `applyFlagSettings`, `streamInput`). This is the natural "LLM chat
     session" processor: PATH pushes each step's prompt as a new user message into the same live session.
  2. **Resume:** sessions persist to disk by default (`persistSession: true`); capture `session_id` from
     the `system/init` message and pass `resume: sessionId` (optionally `forkSession: true`) on a later
     `query()`. `listSessions()` / `getSessionMessages()` enumerate and read past sessions.
  3. **Pre-warm:** `startup({ options })` warms the subprocess before the first query to cut first-step
     latency. ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript))
- **Startup cost per invocation:** subprocess spawn plus harness init per `query()` (same as CLI);
  amortized by streaming-input sessions or `startup()`.

### Context injection

- `prompt` string or streamed user messages; `systemPrompt` accepts a raw string (minimal prompt) or
  `{ type: 'preset', preset: 'claude_code', append: '...' }` to keep the Claude Code system prompt with
  additions; `cwd` sets the workspace; `env` sets subprocess environment; `settings`/`settingSources`
  control filesystem config loading (default loads user+project+local from `.claude/`; set a
  `settingSources: []`-style restriction for hermetic runs); `CLAUDE.md` memory loads through the same
  mechanism. Files: same as CLI — materialize context into `cwd` and let built-in Read/Glob/Grep tools
  pick it up. ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript),
  [overview](https://code.claude.com/docs/en/agent-sdk/overview))

### Output capture

- Typed `SDKMessage` union (assistant/user/tool/result/system/partial); the `result` message carries
  `session_id`, `stop_reason`, `usage` (input/output tokens), and `total_cost_usd` (client-side
  estimate). ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript))
- **Structured output:** `outputFormat: { type: 'json_schema', schema }`, the SDK-native equivalent of
  the CLI's `--json-schema`; validated JSON after the agent completes its workflow.
- **Errors:** error-type result messages plus thrown exceptions on process/connection failure (the docs'
  session example explicitly handles "a single-shot `query()` throws after yielding an error result").
- Subagent attribution through `parent_tool_use_id`, same as the CLI stream.

### Cost & auth

- `ANTHROPIC_API_KEY` (standard API token billing), or Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Claude
  Platform on AWS, Vertex, Foundry. **Note:** "Unless previously approved, Anthropic does not allow third
  party developers to offer claude.ai login or rate limits for their products, including agents built on
  the Claude Agent SDK. Please use the API key authentication methods described in this document
  instead." ([overview](https://code.claude.com/docs/en/agent-sdk/overview)) For PATH: fine while PATH is
  the user's own local tool running under the user's own credentials, but if PATH is ever distributed as
  a product, subscription login must not be the offered auth path.
- Per-invocation cost: `total_cost_usd` plus `usage` on every result message; budget/turn caps through
  `maxTurns` (and CLI-level budget flags through settings).

### MCP servers & skills as worker-side configuration

Everything is an option on the invocation, the purest expression of "capabilities are worker config":

- `mcpServers: Record<string, McpServerConfig>` — stdio (`{command, args}`), HTTP/SSE, **and in-process
  SDK servers**: `tool(name, description, zodSchema, handler)` lets PATH expose engine-native tools (for
  example, "write to PATH context," "emit verdict") to the worker as MCP tools without any subprocess.
  ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript))
- `allowedTools` / `disallowedTools` / `permissionMode` / `canUseTool` callback (programmatic per-call
  approval, the SDK-only feature the CLI lacks) plus `hooks` (PreToolUse/PostToolUse and so on, as
  in-process callbacks).
- `skills: string[] | 'all'` selects skills for the session; skills load from `.claude/skills/*/SKILL.md`;
  `plugins` loads plugin bundles programmatically; `agents: Record<string, AgentDefinition>` defines
  subagents inline (each with its own `tools`, `mcpServers`, `skills`, `model`, `effort`,
  `permissionMode`). ([overview](https://code.claude.com/docs/en/agent-sdk/overview),
  [typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript))

### Fit for PATH

- **In-process TypeScript library** that manages its own child process: the engine gets typed objects
  and callbacks, and the OS process boundary still isolates the model harness from the engine. Best of
  both.
- Session objects map 1:1 to PATH processors; `forkSession` even supports "branch a processor" semantics
  later.
- Portability: macOS now; Linux/Windows already supported by the bundled binary; the worker contract
  (message stream in/out) is transport-agnostic for a future remote runner.
- Risks: the SDK tracks Claude Code's release cadence (fast-moving surface; pin versions);
  subprocess-per-worker memory footprint if PATH runs many parallel processors; API-key-oriented
  (subscription auth is a CLI-side affordance, not an SDK-documented one).

---

## Option 3 — Direct Anthropic API (`@anthropic-ai/sdk`)

Raw Messages API (`POST /v1/messages`) through the official TypeScript client. Reference:
[Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview),
[Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[Pricing](https://platform.claude.com/docs/en/pricing).

### Session lifecycle

- **The API is stateless.** There is no server-side session for plain Messages calls: a "chat session"
  processor is nothing but a `messages[]` array the engine re-sends every turn. PATH would own
  conversation state entirely (which also means it can persist/replay/fork it trivially — state is just
  data in the run record).
- **Startup cost: none.** No subprocess; an HTTPS call per step. Prompt caching (`cache_control`,
  prefix-match) makes multi-step reuse of a shared system prompt/context cheap (about 0.1 times input
  price on cache reads).
- **Agentic loop:** for tool-using steps, either hand-write the `while stop_reason == "tool_use"` loop
  or use the SDK's beta **tool runner** (`client.beta.messages.toolRunner(...)` with
  `betaZodTool`/`betaTool`), which runs the request, then execute, then loop cycle over tools you define,
  with per-turn hooks for approval gating, result modification, retries, and streaming. No built-in
  tools, no filesystem tools, no sandbox; every capability is code PATH writes.
- (For completeness: Anthropic's hosted **Managed Agents** beta provides server-side sessions/containers,
  but it is a cloud-hosted execution surface, the opposite of PATH's local-first model, so it is out of
  scope as the local worker mechanism.)

### Context injection

- Fully structured: `system` (string or blocks with `cache_control`), `messages[]` content blocks (text,
  images, documents/PDF, tool results), Files API (beta) for reusable uploads. PATH's step input/context
  serializes into content blocks under engine control, the most precise injection model of the four
  options, but also the most engine work (no "just read the file" — the worker has no filesystem unless
  PATH gives it a file tool).

### Output capture

- Typed `Message` objects; `stop_reason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`, `pause_turn`)
  is explicit machine-readable status; `usage` (input/output/cache tokens) on every response.
- **Structured output is first-class and schema-enforced:** `output_config: { format: { type:
  'json_schema', schema } }` guarantees schema-valid JSON, or `client.messages.parse()` with a Zod schema
  (`zodOutputFormat`) for validated typed results; `strict: true` on tool definitions guarantees valid
  tool inputs. This is the strongest structured-output guarantee of the four options (the CLI/SDK
  `--json-schema` validates the final result; the API constrains generation itself).
  ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs))
- **Errors:** typed exception classes per HTTP status (`RateLimitError`, `APIConnectionError`, and so on)
  with SDK auto-retry on 429/5xx.

### Cost & auth

- `ANTHROPIC_API_KEY` env var (or `ant auth login` OAuth profile, Workload Identity Federation; the
  zero-arg client resolves credentials from the environment). **No Claude subscription billing**; API
  usage is always token-metered (for example, Opus 4.8 $5/$25 per MTok, Sonnet 4.6 $3/$15, Haiku 4.5
  $1/$5; [Pricing](https://platform.claude.com/docs/en/pricing)). Cheapest per pure-LLM step: no harness
  system prompt overhead, and batch (50% off) and caching apply. Per-invocation cost is `usage` times the
  price table, computed by the engine (no `total_cost_usd` convenience field).

### MCP servers & skills as worker-side configuration

Exists, but thinner and remote-only:

- **MCP connector (beta `mcp-client-2025-11-20`):** pass `mcp_servers: [{type: "url", url, name}]`
  **plus** a matching `tools: [{type: "mcp_toolset", mcp_server_name}]` entry. Anthropic connects to the
  MCP server **server-side**. Remote (Streamable HTTP) servers only; **local stdio MCP servers are not
  supported**. For those, PATH would run the MCP client itself (for example, the Python SDK ships
  MCP-to-tool-runner conversion helpers; TS would use `@modelcontextprotocol/sdk`) and bridge tools into
  the loop.
  ([MCP connector docs via tool-use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview))
- **Skills:** Agent Skills on the Messages API run through `container: {skills: [{type:
  "anthropic"|"custom", skill_id, version}]}` plus the code-execution tool, with betas
  `code-execution-2025-08-25` plus `skills-2025-10-02`. That is, skills execute in **Anthropic's hosted
  container**, not on the user's machine. Local filesystem skills (`SKILL.md` folders) are a Claude
  Code/Agent SDK concept, not a Messages-API one.
  ([Skills](https://platform.claude.com/docs/en/agents-and-tools/skills))

So under the direct API, "MCP + skills as worker config" is only cleanly satisfied for *remote* MCP
servers and *hosted* skills; the local-first versions become engine-implemented features.

### Fit for PATH

- In-process, zero subprocess, npm-only dependency; ideal process model and the best latency/cost for
  **pure prompt+context to structured output** steps (including the judge-step pattern, where
  schema-enforced verdicts feed checkpoints).
- But as the *general* "subagent" worker it forces PATH to build a harness: file access, bash, local MCP
  client, skill loading, permission gating, precisely the wheel the Agent SDK already ships. Right answer
  later as a second lightweight worker type, not as the MVP subagent mechanism.

---

## Option 4 — Local LLM runtimes (fallback/offline; surveyed at lower depth)

### Ollama

- **Lifecycle:** long-running local daemon at `http://localhost:11434/api`
  ([docs.ollama.com/api](https://docs.ollama.com/api)); API "expected to be stable and backwards
  compatible." Models load on first request and stay resident per `keep_alive` (default `5m`), so the
  *runtime* is a persistent server, but chat state is client-side: `/api/chat` takes the full `messages`
  history each call, like the Anthropic API. Startup cost per invocation is about an HTTP call, plus
  model cold-load when not resident.
- **Context injection:** `messages[]` (with `system` role), `options` for model params. No filesystem
  access; pure text in/out.
- **Output capture:** NDJSON streaming or `stream: false`; `format` accepts `"json"` **or a JSON schema
  object** ("generate a response that matches the schema"), real structured output. Tool calling through
  `tools` (JSON schema) with `tool_calls` in responses, model-dependent. Response metrics: `eval_count`,
  `prompt_eval_count`, `total_duration`.
  ([api.md](https://github.com/ollama/ollama/blob/main/docs/api.md))
- **Cost & auth:** the local API has no auth and no cost (hardware/electricity aside); Ollama Cloud
  (`https://ollama.com/api`) exists as a paid hosted variant.
- **MCP/skills:** none in the runtime. Tool calling exists, so PATH's own loop could bridge MCP tools to
  Ollama tool definitions, but PATH would be the MCP host.

### llama.cpp (`llama-server`)

- HTTP server on `127.0.0.1:8080`; one model per process through `-m` (router mode allows multi-model).
  OpenAI-compatible `POST /v1/chat/completions` **and an Anthropic-compatible `POST /v1/messages`**
  endpoint; `json_schema` and GBNF `grammar` parameters constrain generation; tool calling requires
  `--jinja`; SSE streaming; `/health` endpoint.
  ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) The
  Anthropic-compatible endpoint is notable: a PATH worker written against the Anthropic Messages shape
  could point at llama-server with a base-URL swap.

### LM Studio

- Headless through the `llmster` daemon (`lms daemon up`) or `lms server start`; OpenAI-compatible endpoints
  with structured output and tool use; JIT model loading.
  ([headless docs](https://lmstudio.ai/docs/app/api/headless))
- **Uniquely among local runtimes, LM Studio has an MCP story at the API level:** its `/api/v1/chat`
  endpoint accepts MCP integrations either **per-request (ephemeral servers declared inline)** or from
  the app-level `mcp.json`, gated by server settings ("Allow per-request MCPs" / "Allow calling servers
  from mcp.json"), with optional `allowed_tools` filtering and custom auth headers.
  ([Using MCP via API](https://lmstudio.ai/docs/developer/core/mcp))

### Fit for PATH

- All three are localhost HTTP services, the cleanest possible process model (no child process, no SDK)
  and inherently multi-platform. A PATH "local-llm" worker is a thin HTTP client.
- Suitable for offline/no-cost pure-LLM steps with JSON-schema outputs (judge steps, extraction). Not
  suitable as the general subagent worker: no harness, no filesystem tools, no skills, MCP only through LM
  Studio or PATH-built bridging, and output quality is model-dependent.

---

## Comparison table

| | 1. Claude CLI headless | 2. Claude Agent SDK (TS) | 3. Direct Anthropic API | 4. Local runtimes |
|---|---|---|---|---|
| **Process model** | Child process per invocation | In-process TS lib managing a bundled child process | In-process HTTPS client | Local HTTP daemon; engine is a plain HTTP client |
| **Session / processor** | Disk-persisted session ID; `--resume`/`--continue`/`--fork-session`; live multi-turn only via `--input-format stream-json` | Same sessions, typed: `resume`, `forkSession`, streaming-input keeps subprocess alive; `startup()` pre-warm; `listSessions()` | Stateless — engine owns `messages[]`; prompt caching for cheap prefix reuse | Runtime daemon persistent; chat state client-side (`messages[]` per call); `keep_alive` model residency |
| **Startup cost/step** | CLI boot per step (mitigate: `--bare`, `--resume`) | Subprocess spawn per `query()` (mitigate: streaming session, `startup()`) | None (HTTP call) | None (HTTP call; cold model load possible) |
| **Context injection** | argv, stdin (≤10 MB), files in cwd, `--system-prompt*`, `--settings`, `--add-dir` | `prompt`/streamed messages, `systemPrompt` preset+append, `cwd`, `env`, settings objects, in-process MCP tools | Structured `system` + `messages[]` content blocks, Files API; no filesystem unless engine provides tools | `messages[]` JSON only |
| **Structured output** | `--output-format json` (+`session_id`, cost); `--json-schema` gives `structured_output`; `stream-json` NDJSON events | Typed `SDKMessage` stream; `outputFormat: json_schema`; result msg with `usage`, `total_cost_usd` | Strongest: `output_config.format` schema-constrained generation; `messages.parse()` + Zod; `strict` tools; typed `stop_reason` | `format: <json schema>` (Ollama), `json_schema`/GBNF (llama.cpp), OpenAI `response_format` (LM Studio) |
| **Error signaling** | Non-zero exit codes; `system/api_retry` events with typed categories | Error result messages + thrown exceptions | Typed exception classes per HTTP status; SDK auto-retry | HTTP status codes |
| **Auth** | Subscription OAuth login **or** `ANTHROPIC_API_KEY` (`--bare` = key only) | `ANTHROPIC_API_KEY` / Bedrock / Vertex / Foundry; claude.ai login not offerable to third parties | `ANTHROPIC_API_KEY` / `ant auth` profile / WIF | None (localhost) |
| **Billing & cost reporting** | Subscription flat-rate or API tokens; `total_cost_usd` + per-model breakdown; `--max-budget-usd` | API tokens; `total_cost_usd` + `usage` per result | API tokens (cheapest/step; batch −50%, caching); engine computes cost from `usage` | Free (hardware) |
| **MCP as worker config** | `--mcp-config` + `--strict-mcp-config`, `.mcp.json`; stdio/http/sse/ws; `mcp__server__tool` allow-listing | `mcpServers` option incl. **in-process SDK tools**; `canUseTool`, hooks | MCP connector beta: **remote URL servers only**, server-side; local stdio = engine-built bridge | LM Studio: per-request/`mcp.json` MCP; Ollama/llama.cpp: none (tool-calling bridge only) |
| **Skills as worker config** | `.claude/skills` auto-discovery; `/skill-name` in prompt; off under `--bare` | `skills` option, `settingSources`, `plugins`, inline `agents` | Hosted container skills only (code-execution betas); no local SKILL.md | None |
| **Fit as PATH MVP subagent worker** | Good fallback; any-language door-opener; subscription auth | **Best fit** — typed, session-native, capabilities-as-options | Best for lightweight `llm-call` steps later; harness DIY otherwise | Offline/fallback worker type only |

---

## Sources

Claude Code CLI:
- https://code.claude.com/docs/en/headless — headless/`-p` mode, `--bare`, output formats, `--json-schema`, sessions, cost fields, stream events
- https://code.claude.com/docs/en/cli-reference — full flag reference (sessions, permissions, MCP, limits, output)
- https://code.claude.com/docs/en/mcp — `.mcp.json`, scopes, transports, `mcp__` tool naming, plugin MCP servers

Claude Agent SDK:
- https://code.claude.com/docs/en/agent-sdk/overview — packages, bundled binary, auth (incl. third-party claude.ai-login restriction), capabilities, SDK vs CLI vs Managed Agents comparison
- https://code.claude.com/docs/en/agent-sdk/typescript — `query()`, `Options` (mcpServers, skills, agents, resume/forkSession, outputFormat), `SDKMessage`/result shape, streaming input, `startup()`, `tool()`

Anthropic API (platform docs; cross-checked against the loaded `claude-api` skill reference):
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview — tool use, tool runner, MCP connector
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs — `output_config.format`, `messages.parse()`, strict tools
- https://platform.claude.com/docs/en/agents-and-tools/skills — Agent Skills on the Messages API (container + code execution betas)
- https://platform.claude.com/docs/en/pricing — per-model token pricing
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching — prefix caching economics

Local runtimes:
- https://docs.ollama.com/api and https://github.com/ollama/ollama/blob/main/docs/api.md — `/api/chat`, `format` (JSON schema), `tools`, `keep_alive`, response metrics
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md — `llama-server`, OpenAI + Anthropic-compatible endpoints, `json_schema`/`grammar`, `--jinja` tools
- https://lmstudio.ai/docs/app/api/headless — `llmster` daemon, `lms server start`, OpenAI-compat API
- https://lmstudio.ai/docs/developer/core/mcp — MCP via LM Studio's `/api/v1/chat` (ephemeral + `mcp.json` servers)

---

## Open questions (not settled by primary sources)

1. **Subscription auth through the Agent SDK.** The SDK docs only document API-key/provider auth and
   prohibit the *offering* of claude.ai login to third parties. They do not state whether the SDK's
   bundled binary will pick up the user's own existing `claude` subscription login the way the
   interactive CLI does. If PATH wants "works with the user's Claude subscription, no API key," the CLI
   path (non-`--bare`) is the only documented route. Needs empirical verification for the SDK.
2. **Concurrency limits of streaming-input sessions.** Docs do not state resource characteristics of
   many concurrent SDK subprocesses (one per parallel PATH processor), or whether a single subprocess
   can multiplex sessions. Needs a prototype to size parallel-block fan-out.
3. **`total_cost_usd` accuracy under subscription auth.** The field is documented as a client-side
   estimate; how it reports under subscription (flat-rate) login is not specified.
4. **Version pinning strategy.** The CLI/SDK surface changes rapidly (many behaviors documented as
   "requires v2.1.x+"); no LTS channel is documented. PATH should pin the SDK (which bundles its own
   binary) rather than depend on a user-installed `claude`.
5. **LM Studio MCP details** (exact request shape, auth model of ephemeral servers) were confirmed only
   at summary level. If the local-runtime worker ever needs MCP, re-read
   https://lmstudio.ai/docs/developer/core/mcp in full.
