import { z } from "zod";
import type { ConfigValue } from "./config-value-type.js";
import { hasOnlyEnvKey } from "./env.js";
import { hasOnlySecretKey } from "./secret.js";
import { soleKey } from "./wrapper.js";

const EnvWrapperSchema = z
  .object({
    $env: z.string(),
  })
  .strict();

// The nested-compose decision in one schema: `$env` sources a value, `$secret` marks one, and a
// value that is both is the marking laid over the source rather than a third sibling wrapper.
const SecretWrapperSchema = z
  .object({
    $secret: z.union([z.string(), EnvWrapperSchema]),
  })
  .strict();

// Every wrapper the union below accepts, read off the shapes it accepts them in rather than
// respelled — the reserved-namespace check gets its known-key list from here, so a wrapper added to
// the union is reserved against by the same edit and the list cannot drift from what it guards.
const WrapperSchemas = [SecretWrapperSchema, EnvWrapperSchema] as const;
const knownWrapperKeys = WrapperSchemas.flatMap((schema) => Object.keys(schema.shape));

/**
 * Named as a reserved key rather than an unknown wrapper, deliberately (ticket #115): an author who
 * meant a literal `$`-prefixed key has hit a constraint, not made a typo, and one message has to
 * explain itself to them as well as to the author who misspelled `$env`. That value is
 * unexpressible and there is no escape hatch — the cost is stated on purpose, and map #113 parks
 * the hatch until something concrete is blocked by it.
 */
function reservedKeyMessage(key: string): string {
  return (
    `"${key}" is a reserved key — a sole "$"-prefixed key names a config wrapper ` +
    `(known: ${knownWrapperKeys.map((known) => `"${known}"`).join(", ")})`
  );
}

/**
 * A sole `$`-prefixed key is a wrapper or a load error, never literal data — the `$`-sole-key
 * namespace is reserved.
 *
 * A known wrapper key must be a *well-formed* wrapper: a sole `$secret` or `$env` never falls
 * through to being treated as an ordinary object with an oddly-named key. The sole-key rules
 * themselves are secret.ts's and env.ts's, so these and their predicates cannot drift apart on what
 * counts as a wrapper. Any other `$`-key is refused in the same place, so there is one gate on what
 * a `$`-sole-key object may be rather than two that can disagree.
 *
 * The reservation exists because config is `z.record` by design — free-form keys — so §10's strict
 * unknown-field rejection does not reach inside it. Without it `{"$evn": "TOKEN"}` validates as an
 * ordinary config object and the worker receives the *wrapper*, leaking a variable name into an
 * artifact and a missing credential into a step, silently. It also pre-buys the next wrapper:
 * reserving now is what makes a later `$file`/`$keychain` additive rather than ambiguous.
 *
 * Multi-key objects are untouched throughout — the line `isSecretWrapper` already draws. So are a
 * config object's *own* keys (see `ConfigObjectSchema`): this guards value positions, where a
 * wrapper is a value an author wrote in place of a literal.
 */
const PlainConfigObjectSchema = z.lazy(() =>
  z
    .record(ConfigValueSchema)
    .refine((obj) => !hasOnlySecretKey(obj), {
      message: '"$secret" wrapper value must be a string or an {"$env": "NAME"} wrapper',
    })
    .refine((obj) => !hasOnlyEnvKey(obj), {
      message: '"$env" wrapper value must be a string',
    })
    .superRefine((obj, ctx) => {
      const key = soleKey(obj);
      if (key === undefined || !key.startsWith("$") || knownWrapperKeys.includes(key)) return;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: reservedKeyMessage(key) });
    }),
);

/**
 * Config values are literal JSON — never interpolated (workflow-format-v0.md §8) — except for two
 * wrappers: `{"$secret": "<value>"}` marks a value for persistence-boundary redaction
 * (mvp-spec.md §8.3), and `{"$env": "<NAME>"}` sources one from the environment at run start. They
 * compose by nesting, `{"$secret": {"$env": "NAME"}}` being a value that is both sourced and masked.
 */
export const ConfigValueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    ...WrapperSchemas,
    z.array(ConfigValueSchema),
    PlainConfigObjectSchema,
  ]),
);

/**
 * A config object's own keys are field names, not wrapper positions, so the `$`-sole-key
 * reservation does not reach them: `config: {"$evn": "TOKEN"}` declares a config field awkwardly
 * named `$evn`, and the engine reads wrappers per config key (`secret-mask.ts`), never off the
 * whole object. Reserving here would make a one-field config mean something different from a
 * two-field one, which is the arbitrary rule the sole-key line exists to avoid.
 */
export const ConfigObjectSchema = z.record(ConfigValueSchema);
