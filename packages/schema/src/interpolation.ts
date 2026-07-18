import { z } from "zod";
import { checkDotPath } from "./dot-path.js";
import type { JsonValue } from "./json-value.js";

export type InterpolationRoot = "config" | "context" | "output";

export interface InterpolationCheckResult {
  ok: boolean;
  error?: string;
}

function checkPath(path: string, allowedRoots: readonly InterpolationRoot[]): InterpolationCheckResult {
  if (path.length === 0) {
    return { ok: false, error: "empty placeholder: `${}` is not a valid interpolation" };
  }

  const result = checkDotPath(path, allowedRoots);
  if (!result.ok) {
    return { ok: false, error: `${result.error} in "\${${path}}"` };
  }
  return { ok: true };
}

/**
 * Tokenizes an interpolable string, validating `${dot.path}` placeholder syntax and
 * `$${` escaping per workflow-format-v0.md §5. Does not resolve values — that's a runtime concern.
 */
export function checkInterpolationSyntax(
  value: string,
  allowedRoots: readonly InterpolationRoot[],
): InterpolationCheckResult {
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "$") {
      i += 1;
      continue;
    }

    if (value.startsWith("$${", i)) {
      i += 3;
      continue;
    }

    if (value[i + 1] === "{") {
      const close = value.indexOf("}", i + 2);
      if (close === -1) {
        return { ok: false, error: `unclosed placeholder starting at index ${i} in "${value}"` };
      }
      const path = value.slice(i + 2, close);
      const result = checkPath(path, allowedRoots);
      if (!result.ok) {
        return result;
      }
      i = close + 1;
      continue;
    }

    // A bare `$` not followed by `{` or `${` escape is inert literal text.
    i += 1;
  }

  return { ok: true };
}

export function interpolableString(allowedRoots: readonly InterpolationRoot[]) {
  return z.string().superRefine((value, ctx) => {
    const result = checkInterpolationSyntax(value, allowedRoots);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    }
  });
}

export function interpolatedJsonValue(allowedRoots: readonly InterpolationRoot[]): z.ZodType<JsonValue> {
  const schema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
      interpolableString(allowedRoots),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(schema),
      z.record(schema),
    ]),
  );
  return schema;
}
