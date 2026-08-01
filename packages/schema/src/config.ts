import { z } from "zod";
import type { ConfigValue } from "./config-value-type.js";
import { hasOnlyEnvKey } from "./env.js";
import { hasOnlySecretKey } from "./secret.js";

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

// A sole `$secret` or `$env` key must be a well-formed wrapper — never falls through to being
// treated as an ordinary object with an oddly-named key. The sole-key rules themselves are
// secret.ts's and env.ts's, so these and their predicates cannot drift apart on what counts as a
// wrapper.
const PlainConfigObjectSchema = z.lazy(() =>
  z
    .record(ConfigValueSchema)
    .refine((obj) => !hasOnlySecretKey(obj), {
      message: '"$secret" wrapper value must be a string or an {"$env": "NAME"} wrapper',
    })
    .refine((obj) => !hasOnlyEnvKey(obj), {
      message: '"$env" wrapper value must be a string',
    }),
);

/**
 * Config values are literal JSON — never interpolated (workflow-format-v0.md §8) — except for two
 * wrappers: `{"$secret": "<value>"}` marks a value for persistence-boundary redaction (spec §8.3),
 * and `{"$env": "<NAME>"}` sources one from the environment at run start. They compose by nesting,
 * `{"$secret": {"$env": "NAME"}}` being a value that is both sourced and masked.
 */
export const ConfigValueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    SecretWrapperSchema,
    EnvWrapperSchema,
    z.array(ConfigValueSchema),
    PlainConfigObjectSchema,
  ]),
);

export const ConfigObjectSchema = z.record(ConfigValueSchema);
