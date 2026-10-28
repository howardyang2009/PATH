/** The suffix that names an authored file's kind (ADR 0084). */
export const AUTHORED_SUFFIX = {
  workflow: ".workflow.json",
  template: ".step-template.json",
} as const;

/** A `/`-separated subfolder path of plain names: no empty, dot-leading, or backslash segments, so
 * it cannot leave the root it names a folder in. */
export const FOLDER_PATTERN = /^[^\\./\0][^\\/\0]*(\/[^\\./\0][^\\/\0]*)*$/;
