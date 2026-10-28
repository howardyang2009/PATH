import type { AuthoredRootSummary, TemplateSummary, WorkflowSummary } from "@path/client-core";
import type { Message } from "@path/i18n";
import { AUTHORED_SUFFIX, type JsonValue, NAME_PATTERN } from "@path/schema";

export type UploadKind = "workflow" | "template";

export type UploadRefusal = { ok: false; message: Message };

/** A picked file whose suffix names its kind. */
export interface CheckedFile {
  ok: true;
  kind: UploadKind;
  stem: string;
  fileName: string;
}

/** The checks Upload runs before it reads the file: the suffix picks the kind, and a file over the
 * Server's `maxBytes` is refused before the browser parses it. A template's stem is its name, so it
 * must be a plain name; a workflow's stem only must not hide or leave its folder. */
export function checkUploadFile(
  file: { name: string; size: number },
  maxBytes: number | null,
): CheckedFile | UploadRefusal {
  const { name } = file;
  const kind = name.endsWith(AUTHORED_SUFFIX.template)
    ? "template"
    : name.endsWith(AUTHORED_SUFFIX.workflow)
      ? "workflow"
      : undefined;
  if (kind === undefined) {
    return { ok: false, message: { key: "designer.upload.wrongSuffix", params: { name } } };
  }
  if (maxBytes !== null && file.size > maxBytes) {
    return { ok: false, message: { key: "designer.upload.tooLarge", params: { name } } };
  }
  const stem = name.slice(0, -AUTHORED_SUFFIX[kind].length);
  const plain =
    kind === "template" ? NAME_PATTERN.test(stem) : stem !== "" && !/^\.|[\\/]/.test(stem);
  if (!plain) {
    return { ok: false, message: { key: "designer.upload.badName", params: { name } } };
  }
  return { ok: true, kind, stem, fileName: name };
}

/** A picked file read and parsed, its content of the kind its suffix names. */
export interface Upload extends Omit<CheckedFile, "ok"> {
  content: { [key: string]: JsonValue };
  /** The subfolder of the user root it goes into, `""` for the top. */
  folder: string;
}

/** Parse the file's text and check that its content is the kind its suffix names: a workflow file
 * carries a `name`, a template envelope never does. The schema is the Server's to check. */
export function readUpload(
  checked: CheckedFile,
  text: string,
): { ok: true; upload: Upload } | UploadRefusal {
  const params = { name: checked.fileName };
  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch {
    content = undefined;
  }
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return { ok: false, message: { key: "designer.upload.notJson", params } };
  }
  if ("name" in content !== (checked.kind === "workflow")) {
    return { ok: false, message: { key: "designer.upload.kindMismatch", params } };
  }
  const { ok: _ok, ...file } = checked;
  return { ok: true, upload: { ...file, content: content as Upload["content"], folder: "" } };
}

/** What Upload checks a file against: the requester's discovered workflows, writable roots and
 * templates. */
export interface UploadView {
  workflows: readonly WorkflowSummary[];
  roots: readonly AuthoredRootSummary[];
  templates: readonly TemplateSummary[];
}

/** The write an upload makes: a new file, an overwrite of the own file it re-uploads, or a copy
 * under a fresh id and a new name, when another file holds its id or its name. */
export type UploadPlan =
  | { action: "create" | "replace"; path: string }
  | { action: "create" }
  | { action: "replace"; id: string }
  | { action: "copy" }
  | { action: "refuse"; message: Message };

/** The project path a workflow named `fileName` takes in `folder` of the requester's user root
 * (`""` for its top), or `undefined` when the Server lists no user root. */
export function userWorkflowPath(
  roots: readonly AuthoredRootSummary[],
  folder: string,
  fileName: string,
): string | undefined {
  const root = roots.find((entry) => entry.origin === "user")?.relative_path;
  if (root === undefined) return undefined;
  return [root, folder, fileName].filter((part) => part !== "").join("/");
}

export const NO_USER_ROOT: Message = { key: "designer.upload.noUserRoot" };

export function planUpload(upload: Upload, view: UploadView): UploadPlan {
  const id = upload.content.id;
  if (upload.kind === "workflow") {
    const path = userWorkflowPath(view.roots, upload.folder, upload.fileName);
    if (path === undefined) return { action: "refuse", message: NO_USER_ROOT };
    const holder = view.workflows.find((row) => row.id === id);
    const atPath = view.workflows.find((row) => row.relative_path === path);
    if (atPath === undefined && holder === undefined) return { action: "create", path };
    if (atPath !== undefined && atPath === holder) return { action: "replace", path };
    return { action: "copy" };
  }
  const own = (row: TemplateSummary): boolean =>
    row.origin === "user" && (row.folder ?? "") === upload.folder && row.name === upload.stem;
  const holder = view.templates.find((row) => row.id === id);
  const atName = view.templates.find(own);
  if (atName === undefined && holder === undefined) return { action: "create" };
  if (atName !== undefined && atName === holder) return { action: "replace", id: String(id) };
  return { action: "copy" };
}
