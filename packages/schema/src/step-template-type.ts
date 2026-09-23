import { FORMAT_VERSION } from "./workflow-file-type.js";
import type { WorkflowNode } from "./node-type.js";

// A `.step-template.json` is a strict envelope around a workflow **body** that validates exactly as a
// file's body does (ADR 0048). It is a fragment inserted into someone else's workflow file, so it
// carries no file-scoped grammar: no `name` (the file stem is the name), no `worker_defaults` (that
// table is the target file's and live), no `config`/`input`/`output` seed. The envelope shape is
// frozen and unversioned; `format` stamps the **body grammar** (`path/workflow@4`), not the envelope,
// because the only thing checked at load is the body, and the body is a workflow body.
export interface StepTemplate {
  /**
   * The **body** grammar version, the current `FORMAT_VERSION` (`path/workflow@4`) — not a
   * step-template-specific string. The envelope has no grammar of its own to gate; the load-bearing
   * check is the body, which tracks `path/workflow@N`. A `@2`-stamped file names the body grammar this
   * map's tickets discuss but is not a loadable string: it is rejected by the superseded-format path.
   */
  format: typeof FORMAT_VERSION;
  /**
   * The template's own durable GUID (UUIDv4) — its identity, written once at creation and never
   * re-stamped, because a template is not instantiated; only its body's nodes are copied (ADR 0048).
   */
  id: string;
  /** The one human-readable datum, and the palette blurb the Designer renders. Required, non-empty. */
  description: string;
  /**
   * The template body: a `WorkflowNode[]` of minimum length one, the same shape and minimum as a
   * workflow file's body. A one-node template is `body: [node]`; controllers are legal at the top
   * level, since a controller is an ordinary node. The nodes carry their default values inline
   * (a `prompt` node ships its `prompt`/`config`), so the template is a literal parameterized snippet.
   */
  body: WorkflowNode[];
}
