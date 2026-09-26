// The worker *names* the two built-in step types ship, as the closed core node union types a step's
// `worker` field (ADR 0021 sub-1/sub-2). A Worker is a named `run` method of a step type (CONTEXT:
// **Worker**), so the name is the method it performs: `binary` spawns a child process, `prompt` calls a
// model provider. The plugin folders (`packages/engine/plugin/step-plugin/`) are the authority — the
// load validates every `worker` against the scanned registry — so these only keep the typed union honest.

/** `binary`'s worker names; `spawn` (`child_process.spawn`) is its default worker. */
export type BinaryWorkerName = "spawn";

/** `prompt`'s worker names, one per model provider; `anthropic` (the Agent SDK) is its default worker. */
export type PromptWorkerName = "anthropic" | "deepseek";
