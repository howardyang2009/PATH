import { existsSync } from "node:fs";
import type {
  AuthoredKind,
  AuthoredLayout,
  AuthoredOrigin,
  AuthoredRefusal,
  AuthoredRoot,
} from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";
import { type CreatorTable, projectPathOf, SHARED_ITEM_READ_ONLY } from "./creator-table.js";
import { megabytes, type UserLimits } from "./request-limits.js";

// Who may change an authored file (ADR 0088): the requester's view, the layout's shipped and kind
// rules, the creator of a shared item, and the requester's shared-item and file-size limits. Every
// door that writes, removes or leases an authored file asks here, and tells it what it created.

/** A door's refusal of a path it may not change: `404` for a path outside the view. */
export interface WriteRefusal {
  status: 400 | 403 | 404;
  message: string;
}

/** Where a workflow door may act: the confined file, and whether it exists yet. */
export type WorkflowWriteVerdict =
  | { ok: true; absPath: string; exists: boolean }
  | ({ ok: false } & WriteRefusal);

export interface WriteAccess {
  readonly layout: AuthoredLayout;
  /** Whether the requester may change the workflow at `path`: in view, not shipped or a template,
   * inside the project, and for an existing shared file only its creator. A missing file passes,
   * so a door that creates asks {@link createRefusal} next. */
  workflow(path: string): WorkflowWriteVerdict;
  /** Why the requester may not create a new item under `origin`: their shared-item limit. */
  createRefusal(origin: AuthoredOrigin): AuthoredRefusal | undefined;
  /** Why an authored file of `bytes` is over the requester's file size. */
  sizeRefusal(bytes: number): AuthoredRefusal | undefined;
  /** Whether the scanned file at `absPath` under `root` is read-only for the requester: a shipped
   * file always, a shared one unless they created it. */
  readOnly(file: { absPath: string; root: AuthoredRoot }): boolean;
  /** Record the requester as creator of the file a door just created, when it is shared. */
  created(path: string, kind: AuthoredKind): void;
  /** Drop the creator row of the file a door just removed, when it is shared. */
  removed(path: string, kind: AuthoredKind): void;
}

/** The write access of the layout's user; `limits` is `undefined` in local mode, which has none. */
export function writeAccess(
  layout: AuthoredLayout,
  creators: CreatorTable,
  limits?: UserLimits,
): WriteAccess {
  const shared = (path: string): boolean => layout.classify(path)?.origin === "shared";
  const isCreator = (path: string, kind: AuthoredKind): boolean =>
    creators.creatorOf(projectPathOf(layout, path), kind) === layout.userId;

  return {
    layout,
    workflow(path) {
      if (!layout.inView(path)) return { ok: false, status: 404, message: "not found" };
      const refusal = layout.workflowRefusal(path, "write");
      if (refusal !== undefined) return { ok: false, ...refusal };
      // Confinement before any read of the file: an escape or a symlink is a 404 whatever it holds.
      const absPath = confineToProjectRoot(layout.projectDir, path, { allowMissingTail: true });
      if (absPath === undefined) return { ok: false, status: 404, message: "not found" };
      const exists = existsSync(absPath);
      if (exists && shared(path) && !isCreator(path, "workflow")) {
        return { ok: false, status: 403, message: SHARED_ITEM_READ_ONLY };
      }
      return { ok: true, absPath, exists };
    },
    createRefusal(origin) {
      if (origin !== "shared" || limits === undefined) return undefined;
      if (creators.countBy(layout.userId) < limits.maxSharedItems) return undefined;
      return {
        status: 403,
        message: `shared item limit reached (${limits.maxSharedItems}): delete a shared item first`,
      };
    },
    sizeRefusal(bytes) {
      if (limits === undefined || bytes <= limits.maxFileBytes) return undefined;
      return {
        status: 403,
        message: `file too large: an authored file may be at most ${megabytes(limits.maxFileBytes)}`,
      };
    },
    readOnly({ absPath, root }) {
      if (!root.writable) return true;
      return root.origin === "shared" && !isCreator(absPath, root.kind);
    },
    created(path, kind) {
      if (shared(path)) creators.stamp(projectPathOf(layout, path), kind, layout.userId);
    },
    removed(path, kind) {
      if (shared(path)) creators.forget(projectPathOf(layout, path), kind);
    },
  };
}
