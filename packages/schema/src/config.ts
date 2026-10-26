import { z } from "zod";
import { codedIssue } from "./coded-issue.js";
import type { ConfigValue } from "./config-value-type.js";
import { hasOnlyEnvKey } from "./env.js";
import { hasOnlySecretKey } from "./secret.js";
import { soleKey } from "./wrapper.js";

const EnvWrapperSchema = z
  .object({
    $env: z.string(),
  })
  .strict();

// `$env` sources a value, `$secret` marks one; a value that is both nests the marking over the
// source.
const SecretWrapperSchema = z
  .object({
    $secret: z.union([z.string(), EnvWrapperSchema]),
  })
  .strict();

// Known wrapper keys are read off these schemas, so the reserved-key list cannot drift from the
// union.
const WrapperSchemas = [SecretWrapperSchema, EnvWrapperSchema] as const;
const knownWrapperKeys = WrapperSchemas.flatMap((schema) => Object.keys(schema.shape));

/** A sole `$`-prefixed key is a wrapper or a load error, never literal data. Config is `z.record`,
 * so §10's unknown-field rejection does not reach inside it: without this gate `{"$evn": "TOKEN"}`
 * would validate as an ordinary object and the worker would receive the wrapper. Multi-key objects
 * are data. */
const PlainConfigObjectSchema = z.lazy(() =>
  z
    .record(z.string(), ConfigValueSchema)
    .refine((obj) => !hasOnlySecretKey(obj), codedIssue("schema.config.secret-wrapper"))
    .refine((obj) => !hasOnlyEnvKey(obj), codedIssue("schema.config.env-wrapper"))
    .superRefine((obj, ctx) => {
      const key = soleKey(obj);
      if (key === undefined || !key.startsWith("$") || knownWrapperKeys.includes(key)) return;
      // A reserved key, not an unknown wrapper: a literal `$`-prefixed key is unexpressible.
      const known = knownWrapperKeys.map((each) => `"${each}"`).join(", ");
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        ...codedIssue("schema.config.reserved-key", { key, known }),
      });
    }),
);

/** Literal JSON, never interpolated (docs/format/workflow-format.md §7), except two wrappers:
 * `{"$secret": ...}` marks a value for redaction (mvp-spec.md §8.3) and `{"$env": "NAME"}` sources
 * one at run start. */
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
) as z.ZodType<ConfigValue>;

/** A config object's own keys are field names, not wrapper positions: the `$`-sole-key reservation
 * does not reach them — the engine reads wrappers per config key, never off the whole object. */
export const ConfigObjectSchema = z.record(z.string(), ConfigValueSchema);
