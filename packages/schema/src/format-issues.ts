import type { z } from "zod";

/**
 * One line per zod issue, prefixed with the dot-path of the offending field — the shared error
 * shape for every strict-parsed file in the project (workflow files, engine settings).
 */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
