import type { ZodRawShape, ZodTypeAny } from "zod";

import type { StepPluginRegistry } from "./nodes.js";

/**
 * The wire shape of `GET /v0/step-plugins` — the step-plugin registry served to the browser Designer as
 * data (server-api-v0.md §8, ADR 0018). It projects each plugin's live zod `fields` to JSON, since a
 * browser palette cannot scan the engine's plugin folders.
 */

/** One step field projected to a JSON-portable descriptor; `element`/`values` recurse into a container. */
export interface WireFieldSpec {
  type: string;
  optional: boolean;
  element?: WireFieldSpec;
  values?: WireFieldSpec;
}

/** One registered leaf step type on the wire (server-api-v0.md §8), snake_case. */
export interface WireStepPlugin {
  /** The type name — the palette label and the node's `type` discriminant; the plugin folder name. */
  name: string;
  fields: Record<string, WireFieldSpec>;
  /** The worker names the type ships; a per-step worker selector shows only when this holds more than one. */
  workers: string[];
  default_worker: string;
}

export interface StepPluginsResponse {
  step_plugins: WireStepPlugin[];
}

/** A zod schema's `_def.type` kind tag (zod v4 stores it lowercase); undefined for anything else. */
function typeName(schema: ZodTypeAny): string | undefined {
  const def = (schema as { _def?: { type?: unknown } })._def;
  return typeof def?.type === "string" ? def.type : undefined;
}

/** Project one field's zod schema to its descriptor; an unknown kind degrades to the bare `type`. */
export function describeField(schema: ZodTypeAny, optional = false): WireFieldSpec {
  const name = typeName(schema);
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def ?? {};

  // Only `.optional()` sets `optional`; nullable/default decorate the value but do not make the key omittable.
  if (name === "optional") {
    return describeField(def.innerType as ZodTypeAny, true);
  }
  if (name === "nullable" || name === "default") {
    return describeField(def.innerType as ZodTypeAny, optional);
  }

  // zod v4 names an array's element def `element`; a record's value stays `valueType`.
  if (name === "array") {
    return { type: "array", optional, element: describeField(def.element as ZodTypeAny) };
  }
  if (name === "record") {
    return { type: "record", optional, values: describeField(def.valueType as ZodTypeAny) };
  }

  return { type: name ?? "unknown", optional };
}

function describeFields(fields: ZodRawShape): Record<string, WireFieldSpec> {
  const out: Record<string, WireFieldSpec> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = describeField(schema as ZodTypeAny);
  }
  return out;
}

/** Registry → wire projection, sorted by name and reading only the `fields`/worker-name slice (ADR 0018). */
export function toWireStepPlugins(registry: StepPluginRegistry): StepPluginsResponse {
  const step_plugins = Object.keys(registry)
    .sort()
    .map((name) => {
      const entry = registry[name]!;
      return {
        name,
        fields: describeFields(entry.fields),
        workers: Object.keys(entry.workers),
        default_worker: entry.defaultWorker,
      };
    });
  return { step_plugins };
}
