import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  makeStepTemplateSchema,
  type StepPluginRegistry,
  safeParseStepTemplateWith,
  type TemplateSummary,
  type WireError,
} from "@path/schema";
import {
  conditionalWrite,
  PRECONDITION_FAILED,
  readArtifact,
  removeArtifact,
} from "./artifact-file.js";
import { AUTHORED_SUFFIX, type AuthoredLayout, type AuthoredOrigin } from "./authored-layout.js";
import { strongEtag } from "./etag.js";

// The Template store (ADR 0050, ADR 0084): Server-owned, engine-blind discovery of
// shipped∪shared∪user authoring templates. A template is typed by its file **suffix**, never its
// bytes or its folder. The Step-Template is the only kind.

export type TemplateKind = "step";
export type TemplateOrigin = AuthoredOrigin;

const SUFFIX = AUTHORED_SUFFIX.template;

/**
 * One discovered template. `id`/`description`/`format`/`body` are best-effort even when the entry
 * is invalid, so an author can open a broken template to repair it; `id` is `null` only when even a
 * shallow parse cannot recover it, which makes such an entry unaddressable by the by-id routes.
 */
export interface TemplateEntry {
  id: string | null;
  /** The file stem — the template's `name` and palette label, derived from the filename, not the
   * bytes. */
  name: string;
  kind: TemplateKind;
  origin: TemplateOrigin;
  /** The `/`-separated subfolder under its origin's template folder; `""` at the top. */
  folder: string;
  readOnly: boolean;
  /** sha256 of this file's on-disk bytes: the §10.2 read's `etag`, and the token §10.4 compares. */
  etag: string;
  description: string;
  format: string | null;
  /** A step-template's `WorkflowNode[]` body. */
  body: unknown;
  valid: boolean;
  error: WireError["error"] | null;
}

/** An entry plus the file it came from. The path stays behind the store's interface: a caller
 * addresses a template by `id` and the store decides where it lives. */
interface LocatedTemplate extends TemplateEntry {
  absPath: string;
}

/** The user template `id` names, or the refusal: unknown → `404`, shipped → `403` (read-only,
 * ADR 0050 decision 9). */
export type WritableTemplate =
  | { ok: true; entry: TemplateEntry }
  | { ok: false; status: 403 | 404; message: string };

/** A write that landed, addressed by the project-relative path the reply carries. A payload that
 * fails the registry-relative envelope is the `400`, its issues in `details`. */
export type TemplateWrite =
  | { ok: true; id: string; relativePath: string; etag: string }
  | { ok: false; status: 400; message: string; details?: string[] }
  | { ok: false; status: 403 | 404 | 409 | 412; message: string };

export type TemplateRemove = { ok: true } | { ok: false; status: 403 | 404; message: string };

/**
 * The template union one Server serves, and the only door onto the files it holds: a read lists the
 * entries, a write names an `id`. No caller sees an `absPath`, so the conditional-write seam
 * (ADR 0016) cannot be bypassed.
 */
export interface TemplateStore {
  /** Every discovered entry, in scan order: shipped before user, files sorted. */
  readonly entries: readonly TemplateEntry[];
  /**
   * `id → entry` for the by-id routes. First-seen wins — shipped is scanned before user, so a user
   * hand-copy of a shipped id resolves to the shipped entry. Malformed, id-less entries are absent.
   */
  readonly byId: ReadonlyMap<string, TemplateEntry>;
  /** The on-disk bytes of the template `id` names, shipped included, and the file name they save
   * as; `undefined` for an unknown id. */
  download(id: string): { fileName: string; bytes: Buffer } | undefined;
  /** The user entry `id` names, for a door that changes one. */
  writable(id: string): WritableTemplate;
  /** Create a template under `name`, in the optional `folder` below the `origin` template folder
   * (the user's by default); the name is the file stem, so this door never renames.
   * The payload must be a valid envelope whose `id` no entry holds; an existing name or id is the
   * `409` (ADR 0050 decision 6). */
  create(
    kind: TemplateKind,
    name: string,
    payload: unknown,
    folder?: string,
    origin?: "user" | "shared",
  ): TemplateWrite;
  /** Overwrite the user template `id` names with a valid envelope carrying that same `id`, gated
   * on the `If-Match` the caller read from §10.2. */
  update(id: string, payload: unknown, ifMatch: string | undefined): TemplateWrite;
  /** Remove the user template `id` names. §10.5 carries no precondition. */
  remove(id: string): TemplateRemove;
}

/** The validity/identity facts of one step-template file's bytes. Never throws — malformed JSON is
 * invalid. */
function classify(
  bytes: Buffer,
  stepSchema: ReturnType<typeof makeStepTemplateSchema>,
): Pick<TemplateEntry, "id" | "description" | "format" | "body" | "valid" | "error"> {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      id: null,
      description: "",
      format: null,
      body: null,
      valid: false,
      error: { message: "invalid JSON" },
    };
  }

  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const format = typeof obj.format === "string" ? obj.format : null;

  const description = typeof obj.description === "string" ? obj.description : "";
  const body = obj.body ?? null;

  const parsed = safeParseStepTemplateWith(stepSchema, raw);
  const error = parsed.success
    ? null
    : { message: parsed.errors[0] ?? "invalid template", details: parsed.errors };

  return { id, description, format, body, valid: parsed.success, error };
}

/**
 * Discover the shipped∪shared∪user template union, fresh (no cache). Scans the three roots, types
 * each file by its suffix, validates its body registry-relative, and builds the `id → entry` index.
 * A duplicate id invalidates the later entry (shipped, then shared, then user), never the earlier
 * one and never the scan.
 */
export function discoverTemplates(
  layout: AuthoredLayout,
  registry: StepPluginRegistry,
): TemplateStore {
  const { projectDir } = layout;
  const stepSchema = makeStepTemplateSchema(registry);

  const located: LocatedTemplate[] = layout.files("template").map(({ absPath, root }) => {
    const bytes = readFileSync(absPath);
    return {
      name: basename(absPath).slice(0, -SUFFIX.length),
      kind: "step",
      origin: root.origin,
      folder: dirname(relative(root.dir, absPath)).split(sep).join("/").replace(/^\.$/, ""),
      readOnly: !root.writable,
      absPath,
      etag: strongEtag(bytes),
      ...classify(bytes, stepSchema),
    };
  });

  const byId = new Map<string, LocatedTemplate>();
  for (const entry of located) {
    if (entry.id === null) continue;
    const existing = byId.get(entry.id);
    if (existing === undefined) {
      byId.set(entry.id, entry);
    } else {
      // The earlier entry keeps the id; this one is flagged invalid but still lists.
      entry.valid = false;
      entry.error = {
        message: `duplicate id "${entry.id}": already used by ${existing.origin} template "${existing.name}"`,
      };
    }
  }

  const locate = (
    id: string,
  ): { ok: true; entry: LocatedTemplate } | { ok: false; status: 403 | 404; message: string } => {
    const entry = byId.get(id);
    if (entry === undefined) return { ok: false, status: 404, message: "not found" };
    if (entry.readOnly) return { ok: false, status: 403, message: "template is read-only" };
    return { ok: true, entry };
  };

  const validate = (
    payload: unknown,
  ): { ok: true; id: string } | { ok: false; status: 400; message: string; details: string[] } => {
    const parsed = safeParseStepTemplateWith(stepSchema, payload);
    return parsed.success
      ? { ok: true, id: parsed.data.id }
      : { ok: false, status: 400, message: "template validation failed", details: parsed.errors };
  };

  const writeAt = (
    id: string,
    absPath: string,
    payload: unknown,
    precondition: { ifMatch: string | undefined; rule: "create-or-overwrite" | "overwrite" },
  ): TemplateWrite => {
    const written = conditionalWrite(absPath, { ...precondition, payload });
    if (!written.ok) {
      return { ok: false, status: 412, message: PRECONDITION_FAILED[written.conflict] };
    }
    return { ok: true, id, relativePath: relative(projectDir, absPath), etag: written.etag };
  };

  return {
    entries: located,
    byId,
    download(id) {
      const entry = byId.get(id);
      const bytes = entry === undefined ? undefined : readArtifact(entry.absPath);
      return entry === undefined || bytes === undefined
        ? undefined
        : { fileName: `${entry.name}${SUFFIX}`, bytes };
    },
    writable(id) {
      const found = locate(id);
      return found.ok ? { ok: true, entry: found.entry } : found;
    },
    create(kind, name, payload, folder, origin = "user") {
      const valid = validate(payload);
      if (!valid.ok) return valid;
      // A taken id would make the scan flag one of the two entries invalid.
      const holder = byId.get(valid.id);
      if (holder !== undefined) {
        return {
          ok: false,
          status: 409,
          message: `template id "${valid.id}" is already used by ${holder.origin} template "${holder.name}"`,
        };
      }
      const absPath = join(layout.root(origin, "template").dir, folder ?? "", `${name}${SUFFIX}`);
      const written = writeAt(valid.id, absPath, payload, {
        ifMatch: undefined,
        rule: "create-or-overwrite",
      });
      // A create-only write has one conflict: the name is taken. Its wording is this door's 409.
      if (!written.ok) {
        return {
          ok: false,
          status: 409,
          message: `a ${kind} template named "${name}" already exists`,
        };
      }
      return written;
    },
    update(id, payload, ifMatch) {
      const found = locate(id);
      if (!found.ok) return found;
      if ((payload as { id?: unknown } | null)?.id !== id) {
        return { ok: false, status: 400, message: "template id in body must match the URL id" };
      }
      const valid = validate(payload);
      if (!valid.ok) return valid;
      return writeAt(id, found.entry.absPath, payload, { ifMatch, rule: "overwrite" });
    },
    remove(id) {
      const found = locate(id);
      if (!found.ok) return found;
      removeArtifact(found.entry.absPath);
      return { ok: true };
    },
  };
}

/** The template union one server serves, scanned fresh for this request. */
export function templatesOf(ctx: {
  layout: AuthoredLayout;
  stepPlugins: StepPluginRegistry;
}): TemplateStore {
  return discoverTemplates(ctx.layout, ctx.stepPlugins);
}

/** One entry as its thin wire row (§10.1): everything but the body. */
export function templateSummary(entry: TemplateEntry): TemplateSummary {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    origin: entry.origin,
    folder: entry.folder,
    read_only: entry.readOnly,
    valid: entry.valid,
    error: entry.error,
  };
}
