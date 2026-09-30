import { join } from "node:path";

// Where authored files live under a project (ADR 0084): a `shared/` root the team owns and one
// `users/<user-id>/` root per user, each with a `workflow/` and a `template/` folder.

/** The one user until the Server knows who is asking. */
export const DEFAULT_USER_ID = "local";

export type AuthoredOrigin = "shared" | "user";
export type AuthoredKind = "workflow" | "template";

/** The `kind` folder of the `origin` root under `projectDir`, for the current user. */
export function authoredRoot(
  projectDir: string,
  origin: AuthoredOrigin,
  kind: AuthoredKind,
): string {
  return origin === "shared"
    ? join(projectDir, "shared", kind)
    : join(projectDir, "users", DEFAULT_USER_ID, kind);
}
