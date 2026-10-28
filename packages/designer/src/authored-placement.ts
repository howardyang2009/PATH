import { AUTHORED_SUFFIX, FOLDER_PATTERN, NAME_PATTERN } from "@path/schema";

/** The three ways a workflow filename is refused: a backslash, an empty segment, or a segment
 * starting with `.`. Together they keep a save inside the directory the author picked; `/` nests
 * subfolders, which the Server creates on save.
 */
export type WorkflowStemProblem = "backslash" | "emptySegment" | "dotSegment";

/** A workflow filename field, read: the suffix-stripped stem as `a/b` path segments, or the first
 * problem a save must refuse. */
export interface WorkflowStem {
  /** The trimmed stem, suffix stripped and segments joined by `/`; `""` for a blank field. */
  stem: string;
  problem: WorkflowStemProblem | null;
}

/** Read a workflow filename field: strip a trailing `.workflow.json` (case-insensitive), then check
 * its segments. */
export function readWorkflowStem(text: string): WorkflowStem {
  const relative = text.trim().replace(/\.workflow\.json$/i, "");
  if (relative === "") return { stem: "", problem: null };
  if (relative.includes("\\")) return { stem: relative, problem: "backslash" };
  const segments = relative.split("/");
  if (segments.some((segment) => segment.trim() === "")) {
    return { stem: relative, problem: "emptySegment" };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return { stem: relative, problem: "dotSegment" };
  }
  return { stem: segments.map((segment) => segment.trim()).join("/"), problem: null };
}

/** The `.workflow.json` path for a suffix-free `stem` under `directory`; `""` is the project root. */
export function workflowPath(directory: string, stem: string): string {
  const filename = `${stem}${AUTHORED_SUFFIX.workflow}`;
  return directory === "" ? filename : `${directory}/${filename}`;
}

/** The two ways a template name is refused: its name is not a plain slug (`^[a-z][a-z0-9-]*$`), or
 * the folder it lands in is not a `/`-separated path of plain names. */
export type TemplatePlacementProblem = "name" | "folder";

/** A template name field, read: the name and folder it asks for, or the first problem. */
export interface TemplatePlacement {
  /** The template's own name, suffix stripped, from the field's last `/` segment. */
  name: string;
  /** The folder under the picked origin; `undefined` at that origin's top. */
  folder: string | undefined;
  problem: TemplatePlacementProblem | null;
}

/**
 * Read a template name field: strip a trailing `.step-template.json`, split `folder/sub/name` at its
 * last `/`, and join the typed folder onto the one picked in the origin list.
 */
export function readTemplatePlacement(nameText: string, pickedFolder: string): TemplatePlacement {
  const trimmed = nameText.trim();
  const path = trimmed.toLowerCase().endsWith(AUTHORED_SUFFIX.template)
    ? trimmed.slice(0, -AUTHORED_SUFFIX.template.length)
    : trimmed;
  const cut = path.lastIndexOf("/");
  const typedFolder = cut === -1 ? "" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const folder = [pickedFolder, typedFolder].filter((part) => part !== "").join("/") || undefined;
  const problem: TemplatePlacementProblem | null = !NAME_PATTERN.test(name)
    ? "name"
    : folder !== undefined && !FOLDER_PATTERN.test(folder)
      ? "folder"
      : null;
  return { name, folder, problem };
}
