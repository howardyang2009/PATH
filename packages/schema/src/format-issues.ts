import type { z } from "zod";

/** One line per zod issue, prefixed with the dot-path of the offending field. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
