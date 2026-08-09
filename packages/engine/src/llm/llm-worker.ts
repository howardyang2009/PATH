import type { JsonValue } from "@path/schema";

/**
 * One `prompt` step-run's request to an LLM worker. Deliberately **message-shaped** (mvp spec §7):
 * an instruction plus the step's input object, a model, and an opaque worker-side options bag —
 * nothing in it is Agent-SDK-specific, so a headless-CLI worker or a remote runner is a drop-in
 * alternate if the SDK's undocumented keychain auth ever stops working.
 */
export interface PromptRequest {
  /** The `prompt` node's human `name` — used only to name the step in error messages (ADR 0007). */
  nodeName: string;
  /** The interpolated `model` of the effective `llm` worker (format doc §7). */
  model: string;
  /** The interpolated instruction text. */
  prompt: string;
  /** The step's entire input object; the worker renders it alongside the prompt (format §4.2). */
  input: JsonValue;
  /**
   * The `llm` worker declaration's `options` bag verbatim — MCP servers, skills, system prompt.
   * These are worker-side invocation options: no engine code interprets them (mvp spec §7).
   */
  options?: { [key: string]: unknown };
  /** Where the processor's own tools operate; the workflow file's directory unless overridden. */
  cwd: string;
  /** An enclosing `parallel` block's cancellation (mvp spec §5.6) — aborts tear the processor down. */
  signal?: AbortSignal;
}

/**
 * How one prompt step-run ended. `usage` (real token counts) and `estimatedCostUsd` (the SDK's
 * client-side estimate at API list prices) ride on both terminal outcomes — a step that failed
 * mid-conversation still spent tokens, and the run row records what was actually spent (§5.7, §7).
 * A `cancelled` processor was killed before it could report either.
 */
export type PromptResult =
  | { status: "succeeded"; output: string; usage: JsonValue | null; estimatedCostUsd: number | null }
  | { status: "failed"; error: string; usage: JsonValue | null; estimatedCostUsd: number | null }
  | { status: "cancelled" };

/**
 * The seam the engine executes `prompt` steps through. Every call spawns a **fresh processor**,
 * torn down when the call settles — no session reuse in MVP, so a step reads exactly what its
 * `input` map builds (mvp spec §5.5).
 */
export interface LlmWorker {
  runPrompt(request: PromptRequest): Promise<PromptResult>;
}
