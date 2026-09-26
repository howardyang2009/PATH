import { z } from "zod";
import { checkDotPath } from "./dot-path.js";
import type { JsonValue } from "./json-value.js";
import type { InterpolationRoot } from "./roots.js";

export type { InterpolationRoot } from "./roots.js";

export interface InterpolationCheckResult {
  ok: boolean;
  error?: string;
}

/** One piece of an interpolable string (docs/format/workflow-format.md §6). A bare `$` not followed by `{` is
 * inert literal text and arrives inside a `literal` token. */
export type InterpolationToken =
  | { kind: "literal"; text: string }
  /** A `$${` escape: the substituted result is a literal `${`. */
  | { kind: "escape" }
  | { kind: "placeholder"; path: string }
  /** A `${` with no closing `}`. Rejected at load time; a runtime consumer must still handle it. */
  | { kind: "unclosed"; index: number };

/** Tokenizes an interpolable string per docs/format/workflow-format.md §6 — the one place the placeholder
 * grammar is implemented, so `unclosed` is a token every consumer must handle. Resolves nothing:
 * what a `path` refers to is the caller's business. */
export function* tokenizeInterpolation(value: string): Generator<InterpolationToken> {
  let literalStart = 0;
  let i = 0;

  function* flushLiteral(upTo: number): Generator<InterpolationToken> {
    if (upTo > literalStart) yield { kind: "literal", text: value.slice(literalStart, upTo) };
  }

  while (i < value.length) {
    if (value[i] !== "$") {
      i += 1;
      continue;
    }

    if (value.startsWith("$${", i)) {
      yield* flushLiteral(i);
      yield { kind: "escape" };
      i += 3;
      literalStart = i;
      continue;
    }

    if (value[i + 1] === "{") {
      const close = value.indexOf("}", i + 2);
      if (close === -1) {
        yield* flushLiteral(i);
        yield { kind: "unclosed", index: i };
        return;
      }
      yield* flushLiteral(i);
      yield { kind: "placeholder", path: value.slice(i + 2, close) };
      i = close + 1;
      literalStart = i;
      continue;
    }

    i += 1;
  }

  yield* flushLiteral(value.length);
}

/** Validates `${dot.path}` syntax and `$${` escaping (docs/format/workflow-format.md §6); resolves nothing. */
export function checkInterpolationSyntax(
  value: string,
  allowedRoots: readonly InterpolationRoot[],
): InterpolationCheckResult {
  for (const token of tokenizeInterpolation(value)) {
    if (token.kind === "unclosed") {
      return {
        ok: false,
        error: `unclosed placeholder starting at index ${token.index} in "${value}"`,
      };
    }
    if (token.kind !== "placeholder") continue;

    if (token.path.length === 0) {
      return { ok: false, error: "empty placeholder: `${}` is not a valid interpolation" };
    }
    const result = checkDotPath(token.path, allowedRoots);
    if (!result.ok) {
      return { ok: false, error: `${result.error} in "\${${token.path}}"` };
    }
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

export function interpolatedJsonValue(
  allowedRoots: readonly InterpolationRoot[],
): z.ZodType<JsonValue> {
  const schema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
      interpolableString(allowedRoots),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(schema),
      z.record(z.string(), schema),
    ]),
  ) as z.ZodType<JsonValue>;
  return schema;
}
