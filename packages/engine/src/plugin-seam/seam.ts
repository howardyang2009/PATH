import type { JsonValue } from "@path/schema";
import type { ZodRawShape, z } from "zod";

// The TS seam a step-type plugin implements and the engine dispatches through; shipped `binary`/`prompt` compile
// against it (ADR 0019 sub-5).

/**
 * One leaf step-run's request: the engine builds it after interpolating `fields`, threading the predecessor's output
 * into `input`, and resolving `config` — a worker reads exactly this, never the node, ancestry, or `process.env`.
 */
export interface StepRequest<
  F extends ZodRawShape = ZodRawShape,
  C extends ZodRawShape = ZodRawShape,
> {
  fields: z.infer<z.ZodObject<F>>;
  input: JsonValue;
  config: z.infer<z.ZodObject<C>>;
  /**
   * The workflow file's directory — the anchor a worker resolves its own relative paths against, never
   * `process.cwd()`.
   */
  cwd: string;
  /** A `parallel` block's cancellation; the engine derives `cancelled` from `signal.aborted`. */
  signal: AbortSignal;
}

// One leaf step-run's terminal outcome; the engine owns `cancelled`, derived from `request.signal.aborted`.
// `stderr` is captured diagnostic text, not a process stream — return it here, never write to a stream.
export type StepResult =
  | {
      status: "succeeded";
      output: JsonValue;
      usage?: JsonValue;
      estimatedCostUsd?: number;
      stderr?: string;
    }
  | {
      status: "failed";
      error: string;
      usage?: JsonValue;
      estimatedCostUsd?: number;
      stderr?: string;
    }
  // A parked run may echo an informational `assignee` for the `step-awaiting` record; omitted otherwise.
  | { status: "awaiting"; assignee?: string };

/**
 * One named worker: a `run` method plus the capability flags the engine reads before calling it — it acquires a
 * processor slot for a metering worker and holds it for the call.
 */
export interface WorkerDescriptor<
  F extends ZodRawShape = ZodRawShape,
  C extends ZodRawShape = ZodRawShape,
> {
  run(request: StepRequest<F, C>): Promise<StepResult>;
  meters: boolean;
  needsProcessorSlot: boolean;
}

// A step type's whole contribution: two typed fragments, named workers, and the default worker. The folder
// name *is* the type name; `fields` is strict/load-validated, `config` open and run-start-validated.
export interface StepPlugin<
  F extends ZodRawShape = ZodRawShape,
  C extends ZodRawShape = ZodRawShape,
> {
  fields: F;
  config: C;
  workers: { [name: string]: WorkerDescriptor<F, C> };
  defaultWorker: string;
}

/**
 * Identity helper: `F`/`C` infer from the inline `fields`/`config` fragments so every `workers[*].run` is typed;
 * returns its argument unchanged (ADR 0019 sub-5).
 */
export function defineStepPlugin<F extends ZodRawShape, C extends ZodRawShape>(
  plugin: StepPlugin<F, C>,
): StepPlugin<F, C> {
  return plugin;
}
