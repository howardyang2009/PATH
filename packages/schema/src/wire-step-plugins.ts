import type { ZodRawShape, ZodTypeAny } from "zod";

import type { StepPluginRegistry } from "./nodes.js";

/**
 * The wire shape of `GET /v0/step-plugins` — the server's step-plugin registry served to the browser
 * Designer as data (server-api-v0.md §8, designer-spec.md § The v1 authoring palette, ADR 0018). The
 * Designer is a pure browser consumer: it cannot scan `packages/engine/step-plugins/`, so the grammar
 * it may author arrives over the wire and its palette is registry-driven.
 *
 * One entry per registered leaf step type — the built-ins `prompt` and `binary` (ADR 0021) and every
 * other plugin folder, peers of each other. The `workflow` sub-workflow ref is *not* here: it is
 * grammar-fixed, not a plugin folder, and the Designer supplies it from the block grammar itself.
 *
 * Field casing is snake_case (§1), as every v0 wire shape is; `@path/client-core` presents these
 * camelCase and translates at the wire boundary (ADR 0013).
 *
 * **This module owns the on-the-wire shape of a `fields` fragment.** A plugin's `fields` is a
 * `ZodRawShape` — live zod schema objects, not JSON — so the route cannot serialize them straight:
 * `JSON.stringify(z.string())` leaks zod's internal `_def`, version-fragile and useless to an editor.
 * `describeField` projects each field to a small, stable descriptor the generic editor can lay a
 * control out from. The *per-field control mapping* (which descriptor renders as which input) is
 * deferred to a later #254 ticket (designer-spec.md § Still open); the raw-JSON floor covers any type
 * a form cannot lay out, so this descriptor need only be honest and JSON-portable, not exhaustive.
 */

/**
 * One field of a step type's `fields` fragment, projected from its zod schema. `type` is the zod kind
 * with the `Zod` prefix dropped and lowercased (`string`, `number`, `boolean`, `array`, `record`,
 * `object`, `unknown`, …); an unrecognized kind falls through to that lowercased name rather than
 * throwing, so a future plugin's exotic field still serializes (the editor drops it to the raw-JSON
 * floor). `optional` is true when the field is wrapped `.optional()`. `element`/`values` recurse into a
 * container so an array-of / record-of keeps its inner kind.
 */
export interface WireFieldSpec {
  type: string;
  optional: boolean;
  element?: WireFieldSpec;
  values?: WireFieldSpec;
}

/** One registered leaf step type on the wire (server-api-v0.md §8), snake_case. */
export interface WireStepPlugin {
  /** The type name — the palette label and the node's `type` discriminant. It is the plugin folder name. */
  name: string;
  /** The type's declared `fields` fragment, each field projected to a descriptor (see `WireFieldSpec`). */
  fields: Record<string, WireFieldSpec>;
  /** The worker names the type ships. A per-step worker selector is shown only when this holds more than one. */
  workers: string[];
  /** The worker a step of this type uses when it names none. */
  default_worker: string;
}

/** `GET /v0/step-plugins` — one snake_case entry per registered leaf step type (server-api-v0.md §8). */
export interface StepPluginsResponse {
  step_plugins: WireStepPlugin[];
}

/** Read a zod schema's kind tag, e.g. `ZodString`, from its def. Undefined for anything not a zod schema. */
function typeName(schema: ZodTypeAny): string | undefined {
  const def = (schema as { _def?: { typeName?: unknown } })._def;
  return typeof def?.typeName === "string" ? def.typeName : undefined;
}

/** The lowercase wire `type` for a zod kind tag: `ZodString` → `string`, `ZodRecord` → `record`. */
function wireKind(name: string): string {
  return name.replace(/^Zod/, "").toLowerCase();
}

/**
 * Project one field's zod schema to its wire descriptor (see `WireFieldSpec`). It unwraps the
 * optional/nullable/default wrappers to a base kind — recording `optional` when it meets `.optional()`
 * — then reads the container inner type for an array or a record. It reads zod internals (`_def`)
 * because zod v3 ships no public schema-to-JSON, and it never throws on an unknown kind: the descriptor
 * degrades to the bare `type`, and the editor's raw-JSON floor takes it from there.
 */
export function describeField(schema: ZodTypeAny, optional = false): WireFieldSpec {
  const name = typeName(schema);
  const def = (schema as { _def?: Record<string, unknown> })._def ?? {};

  // Unwrap the wrappers that only decorate an inner schema. `ZodOptional` sets `optional`; nullable and
  // default do not — the descriptor names *whether the key may be omitted*, which only `.optional()` is.
  if (name === "ZodOptional") {
    return describeField(def.innerType as ZodTypeAny, true);
  }
  if (name === "ZodNullable" || name === "ZodDefault") {
    return describeField(def.innerType as ZodTypeAny, optional);
  }

  if (name === "ZodArray") {
    return { type: "array", optional, element: describeField(def.type as ZodTypeAny) };
  }
  if (name === "ZodRecord") {
    return { type: "record", optional, values: describeField(def.valueType as ZodTypeAny) };
  }

  return { type: name ? wireKind(name) : "unknown", optional };
}

/** Project one `fields` fragment (a `ZodRawShape`) to its wire descriptor map, field name → descriptor. */
function describeFields(fields: ZodRawShape): Record<string, WireFieldSpec> {
  const out: Record<string, WireFieldSpec> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = describeField(schema as ZodTypeAny);
  }
  return out;
}

/**
 * The registry → wire projection `GET /v0/step-plugins` serves. Entries are sorted by name so the
 * response is deterministic regardless of the registry's key order. Worker names keep the plugin's own
 * registration order — `default_worker` names the default outright, so their order carries no meaning
 * the client must trust. Reads only the `@path/schema` slice of a plugin (`fields`, worker names,
 * `defaultWorker`), never a `run` method, so it stays a pure function of its input (ADR 0018 sub-3).
 */
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
