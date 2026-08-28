// The worker *names* each built-in step type ships (ADR 0021 sub-1/sub-2). A Worker is a named
// `run` method of a step type (CONTEXT: **Worker**), so the name is the method it performs —
// `binary` spawns a child process (`spawn`), `prompt` calls the Agent SDK (`sdk`). The pair
// `(type, name)` is a worker's identity, so a name is unique only inside its type.
//
// The node union is still closed here (ADR 0021 realized on the pre-plugin union, #332): the names
// are fixed constants, and the step schema (`nodes.ts`) builds each type's `worker` enum from the
// matching list. When the union opens to plugins these come off the folder scan instead — a step
// type ships one or more workers, and the enum widens with no grammar change.

/** `binary`'s worker names; `spawn` (`child_process.spawn`) is the default worker. */
export const BINARY_WORKER_NAMES = ["spawn"] as const;
/** The worker a `binary` step uses when it names none (`@3` §4). */
export const BINARY_DEFAULT_WORKER = "spawn";

/** `prompt`'s worker names; `sdk` (the Agent SDK) is the default worker. `cli`/`remote` are unbuilt. */
export const PROMPT_WORKER_NAMES = ["sdk"] as const;
/** The worker a `prompt` step uses when it names none (`@3` §4). */
export const PROMPT_DEFAULT_WORKER = "sdk";

export type BinaryWorkerName = (typeof BINARY_WORKER_NAMES)[number];
export type PromptWorkerName = (typeof PROMPT_WORKER_NAMES)[number];
