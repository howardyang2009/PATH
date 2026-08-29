import type { JsonValue } from "@path/schema";
import type { z, ZodRawShape } from "zod";

/**
 * The TS seam a step-type plugin implements, and the engine dispatches through (#313). It mirrors
 * the swappable worker seams it replaces — `binary`'s child-process worker and `prompt`'s LLM worker
 * (ADR 0021 sub-4 folds both into this one). A plugin declares two typed zod fragments and a map of
 * named workers; the engine merges/resolves `config`, validates `fields` at load and `config` at
 * run-start, then calls the selected worker's `run` (ADR 0022).
 *
 * Wired into production since the cutover (#337): the engine dispatches every leaf step through the
 * `WorkerDescriptor.run` here, and the shipped `binary`/`prompt` folders (ADR 0021 sub-6) compile
 * against it, so a gap here breaks PATH's own step types.
 */

/**
 * One leaf step-run's request to a worker. The engine builds it after it has interpolated the node's
 * `fields`, threaded the predecessor's single `output` into `input`, and merged+resolved `config`
 * down the ancestry (`$env`/`$secret` already applied — ADR 0022 sub-3). A worker reads exactly this;
 * it never re-reads the node, the ancestry, or `process.env`.
 *
 * `F` and `C` are the plugin's own `fields`/`config` `ZodRawShape` fragments, so a worker's `run`
 * sees `fields` and `config` inferred from its own type's declaration (ADR 0022, acceptance #4). The
 * defaults keep the engine's generic dispatch — which holds no single plugin's shapes — well typed.
 */
export interface StepRequest<F extends ZodRawShape = ZodRawShape, C extends ZodRawShape = ZodRawShape> {
  /**
   * The node's author-fixed `fields` after interpolation, typed by the plugin's own `fields` fragment
   * (ADR 0022: a field says *what the step does* — `binary`'s `command`, `api-call`'s `endpoint`).
   */
  fields: z.infer<z.ZodObject<F>>;
  /** The predecessor's single output object — one opaque `JsonValue`, no per-type input schema (ADR 0022 sub-7). */
  input: JsonValue;
  /**
   * The effective merged config after `$env`/`$secret` resolution, typed by the plugin's own `config`
   * fragment (ADR 0022 sub-4: leaf types describe the *resolved* value). Config is open/passthrough, so
   * at run time it also carries keys a sibling leaf type declared; a worker reads only its own (sub-2).
   */
  config: z.infer<z.ZodObject<C>>;
  /**
   * The workflow file's directory — the anchor a worker resolves its own relative paths against, via
   * `resolveAgainstWorkflowDir`, never `process.cwd()` (#313 sub-14, ADR 0019 sub-8). `binary`'s `spawn`
   * resolves its `cwd` field against this.
   */
  cwd: string;
  /**
   * A `parallel` block's cancellation (mvp spec §5.6) — an abort tears the processor down. The engine
   * derives the `cancelled` status from `signal.aborted`, which is why `StepResult` carries no
   * `cancelled` case.
   */
  signal: AbortSignal;
}

/**
 * How one leaf step-run ended. Only the two *terminal* outcomes a worker can report: the engine owns
 * `cancelled`, deriving it from `request.signal.aborted` rather than trusting a worker to distinguish a
 * kill from a genuine failure (ADR 0021 sub-7). `usage` (real token counts) and `estimatedCostUsd`
 * ride both outcomes — a step that failed mid-conversation still spent tokens (mvp spec §5.7) — and
 * are omitted by a worker that meters nothing. `stderr` is captured for the audit blob regardless of
 * how the run ended (format doc §4.2). `output` is a `JsonValue`; `parse: "json"` (a shared envelope
 * field, ADR 0022 sub-8) applies only when it is a string.
 */
export type StepResult =
  | { status: "succeeded"; output: JsonValue; usage?: JsonValue; estimatedCostUsd?: number; stderr?: string }
  | { status: "failed"; error: string; usage?: JsonValue; estimatedCostUsd?: number; stderr?: string };

/**
 * One named worker of a step type — a `run` method plus the closed set of capability flags the engine
 * reads before calling it (ADR 0021 sub-5). The engine owns the capabilities the flags name, so a
 * worker only *declares* it needs them; it holds none of the machinery itself.
 */
export interface WorkerDescriptor<F extends ZodRawShape = ZodRawShape, C extends ZodRawShape = ZodRawShape> {
  /** The method that produces this step's output. One call per run; the processor is fresh each time (no session reuse in MVP). */
  run(request: StepRequest<F, C>): Promise<StepResult>;
  /**
   * The worker reports spend (`usage`/`estimatedCostUsd` on its result). The engine emits the usage
   * observer event only for a metering worker; `prompt`'s `sdk` sets it, `binary`'s `spawn` does not.
   */
  meters: boolean;
  /**
   * The worker needs a processor-concurrency slot before it runs, so the engine acquires one from the
   * processor semaphore and holds it for the call (#331 rename, ADR 0021 sub-5). `prompt`'s `sdk` sets
   * it; `binary`'s `spawn` stays uncapped.
   */
  needsProcessorSlot: boolean;
}

/**
 * A step type's whole contribution: its two typed fragments, its named workers, and which worker a
 * step of this type uses when it names none (CONTEXT: **Default worker**). The folder name *is* the
 * type name (ADR 0019 sub-1), so the plugin states no type name here. `fields` is `.strict()` and
 * validated at load; `config` is open and validated at run-start (ADR 0022 sub-2/sub-3) — the schema
 * factory adds that, so a plugin declares only the shapes.
 */
export interface StepPlugin<F extends ZodRawShape = ZodRawShape, C extends ZodRawShape = ZodRawShape> {
  /** Author-fixed node fields, `ZodRawShape` (ADR 0022 sub-1). Strict + load-validated by the factory. */
  fields: F;
  /** Injected, inheritable, `$env`/`$secret`-capable config keys, `ZodRawShape`. Open + run-start-validated. */
  config: C;
  /** The type's workers by name; `(type, name)` is a worker's identity, so a name is unique only here. */
  workers: { [name: string]: WorkerDescriptor<F, C> };
  /** The worker a step of this type uses when it names none. A required key, not a reserved worker name. */
  defaultWorker: string;
}

/**
 * Identity/typing helper: a plugin's `index.ts` wraps its object in this so `F`/`C` infer from the
 * `fields`/`config` fragments it writes inline, and every `workers[*].run` is then typed against those
 * fragments (ADR 0019 sub-5, ADR 0022). It changes nothing at run time — it returns its argument — and
 * exists only so `stepPlugin` is checked against the contract at author time.
 */
export function defineStepPlugin<F extends ZodRawShape, C extends ZodRawShape>(
  plugin: StepPlugin<F, C>,
): StepPlugin<F, C> {
  return plugin;
}
