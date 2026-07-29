import { z } from "zod";
import type { ConfigValue } from "./config-value-type.js";
import { hasOnlySecretKey } from "./secret.js";

const SecretWrapperSchema = z
  .object({
    $secret: z.string(),
  })
  .strict();

// A sole `$secret` key must be a well-formed wrapper (string value) — never falls through to
// being treated as an ordinary object with an oddly-named key. The sole-key rule itself is
// secret.ts's, so this and `isSecretWrapper` cannot drift apart on what counts as a wrapper.
const PlainConfigObjectSchema = z.lazy(() =>
  z.record(ConfigValueSchema).refine((obj) => !hasOnlySecretKey(obj), {
    message: '"$secret" wrapper value must be a string',
  }),
);

/**
 * Config values are literal JSON — never interpolated (workflow-format-v0.md §8) — except for the
 * `{"$secret": "<value>"}` wrapper, which marks a value for persistence-boundary redaction (spec §8.3).
 */
export const ConfigValueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    SecretWrapperSchema,
    z.array(ConfigValueSchema),
    PlainConfigObjectSchema,
  ]),
);

export const ConfigObjectSchema = z.record(ConfigValueSchema);
