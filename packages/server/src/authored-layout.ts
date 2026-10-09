import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Where authored files live (ADR 0084): a read-only shipped root in the PATH install, then a
// `shared/` root the team owns and one `users/<user-id>/` root per user under the project, each
// with a `workflow/` and a `template/` folder. Every door asks this module where a file sits.

/** The folder each user's root sits in, one subfolder per user id. */
export const USERS_DIR = "users";

/** The one user until the Server knows who is asking. */
export const DEFAULT_USER_ID = "local";

export type AuthoredOrigin = "shipped" | "shared" | "user";
export type AuthoredKind = "workflow" | "template";

export interface AuthoredRoot {
  origin: AuthoredOrigin;
  kind: AuthoredKind;
  /** Absolute and `resolve`d, so paths joined off it match the loader's keys. */
  dir: string;
  writable: boolean;
}

/** Where a path sits: its root's facts without the root's folder. */
export type AuthoredPlace = Pick<AuthoredRoot, "origin" | "kind" | "writable">;

/** A door's refusal of a path: the status and message it replies with. */
export interface AuthoredRefusal {
  status: 400 | 403;
  message: string;
}

/** The file suffix that types an authored file by its kind. */
export const AUTHORED_SUFFIX: Record<AuthoredKind, string> = {
  workflow: ".workflow.json",
  template: ".step-template.json",
};

export const DEFAULT_SHIPPED_DIR: Record<AuthoredKind, string> = {
  workflow: fileURLToPath(new URL("../shipped/workflow", import.meta.url)),
  template: fileURLToPath(new URL("../shipped/template", import.meta.url)),
};

export interface AuthoredLayout {
  /** The project directory, `resolve`d. */
  readonly projectDir: string;
  /** The user whose root this layout reads and writes. */
  readonly userId: string;
  /** The roots of `kind` in precedence order: shipped, shared, user. */
  roots(kind: AuthoredKind): readonly AuthoredRoot[];
  root(origin: AuthoredOrigin, kind: AuthoredKind): AuthoredRoot;
  /** The root a project-relative path sits under, or `undefined` for a path under none. */
  classify(projectPath: string): AuthoredPlace | undefined;
  /** Every file of `kind` in its roots, in precedence order, each root's files sorted. */
  files(kind: AuthoredKind): { absPath: string; root: AuthoredRoot }[];
  /** Whether a door or a `ref` may reach `path`: in hosted mode only the requester's view of
   * shipped, shared and own roots (ADR 0088), in local mode anywhere. */
  inView(path: string): boolean;
  /** Why a workflow door must not act on `projectPath`: a template is not a workflow, and a
   * shipped workflow is never written or run in place (ADR 0086). */
  workflowRefusal(projectPath: string, door: "write" | "run"): AuthoredRefusal | undefined;
}

export interface AuthoredLayoutOptions {
  projectDir: string;
  /** A test may point a kind's shipped root elsewhere. */
  shippedDir?: Partial<Record<AuthoredKind, string>>;
  userId?: string;
  /** Hosted mode confines doors and refs to the view; local mode follows paths anywhere. */
  hosted?: boolean;
}

export function authoredLayout({
  projectDir,
  shippedDir = {},
  userId = DEFAULT_USER_ID,
  hosted = false,
}: AuthoredLayoutOptions): AuthoredLayout {
  const project = resolve(projectDir);
  const rootsOf = (kind: AuthoredKind): AuthoredRoot[] => [
    {
      origin: "shipped",
      kind,
      dir: resolve(shippedDir[kind] ?? DEFAULT_SHIPPED_DIR[kind]),
      writable: false,
    },
    { origin: "shared", kind, dir: join(project, "shared", kind), writable: true },
    { origin: "user", kind, dir: join(project, USERS_DIR, userId, kind), writable: true },
  ];
  const byKind: Record<AuthoredKind, AuthoredRoot[]> = {
    workflow: rootsOf("workflow"),
    template: rootsOf("template"),
  };
  // The template folder of any user is a template root: no workflow door may write one.
  const anyUserTemplate = (abs: string): boolean => {
    const parts = relative(project, abs).split(/[\\/]/);
    return parts[0] === USERS_DIR && parts.length >= 3 && parts[2] === "template";
  };

  const allRoots = [...byKind.workflow, ...byKind.template];
  const classify = (projectPath: string): AuthoredPlace | undefined => {
    const abs = resolve(project, projectPath);
    const found = allRoots.find((root) => within(root.dir, abs));
    if (found !== undefined || !anyUserTemplate(abs)) return found;
    return { origin: "user", kind: "template", writable: true };
  };

  return {
    projectDir: project,
    userId,
    roots: (kind) => byKind[kind],
    root: (origin, kind) => byKind[kind].find((root) => root.origin === origin) as AuthoredRoot,
    classify,
    inView: (path) => {
      if (!hosted) return true;
      const abs = resolve(project, path);
      const root = allRoots.find((candidate) => within(candidate.dir, abs));
      return root !== undefined && !crossesSymlink(root.dir, abs);
    },
    files: (kind) =>
      byKind[kind].flatMap((root) =>
        scanFiles(root.dir, AUTHORED_SUFFIX[kind]).map((absPath) => ({ absPath, root })),
      ),
    workflowRefusal(projectPath, door) {
      const root = classify(projectPath);
      if (root?.kind === "template") {
        return { status: 400, message: "workflow path must not be a template path" };
      }
      if (root?.origin === "shipped") {
        return {
          status: 403,
          message:
            door === "write"
              ? "a shipped workflow is read-only"
              : "a shipped workflow must be copied before it runs",
        };
      }
      return undefined;
    },
  };
}

/** Whether `abs` is `dir` or lies under it, lexically. */
function within(dir: string, abs: string): boolean {
  const rel = relative(dir, abs);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

/** Whether a component of `abs` below `dir` is a symlink, which could lead out of the view. A
 * missing component ends the walk: nothing below it exists to follow. */
function crossesSymlink(dir: string, abs: string): boolean {
  let current = dir;
  for (const segment of relative(dir, abs).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Every file under `root` ending with `suffix`, as sorted absolute paths; `[]` when `root` is
 * absent. Skips `node_modules` and dot-directories. Symlinks are neither followed nor listed: the
 * loader canonicalizes lexically, so following one would alias a nested file as a discovered root. */
function scanFiles(root: string, suffix: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Checked before isDirectory()/isFile(): a symlink reports neither.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}
