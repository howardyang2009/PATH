import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeStepTemplateSchema,
  type StepPluginRegistry,
  safeParseStepTemplateWith,
  type TemplateSummary,
  type WireError,
} from "@path/schema";

// The Template store (ADR 0050): Server-owned, engine-blind discovery of shipped∪user authoring
// templates. A template is typed by its file **suffix**, never its bytes, so the two maps below are the
// whole classification. The Step-Template is the only kind.

export type TemplateKind = "step";
export type TemplateOrigin = "shipped" | "user";

const SUFFIX: Record<TemplateKind, string> = {
  step: ".step-template.json",
};

const KIND_DIR: Record<TemplateKind, string> = {
  step: "step-template",
};

export function suffixFor(kind: TemplateKind): string {
  return SUFFIX[kind];
}

export function kindDirFor(kind: TemplateKind): string {
  return KIND_DIR[kind];
}

/** The `.path/template/<kind-dir>/` root under a project, where every writable (user) template lives. */
export function userTemplateRoot(projectDir: string): string {
  return join(projectDir, ".path", "template");
}

/** The shipped (read-only) template root: `packages/server/template`. A missing directory scans as an
 * empty contribution, never a Server-start failure; a caller (a test) may inject a different root. */
export const DEFAULT_SHIPPED_TEMPLATE_DIR = fileURLToPath(new URL("../template", import.meta.url));

/** The shipped root the union scans: the context override, or the package-relative default. */
export function shippedTemplateDir(ctx: { shippedTemplateDir?: string }): string {
  return ctx.shippedTemplateDir ?? DEFAULT_SHIPPED_TEMPLATE_DIR;
}

/**
 * One discovered template. `id`/`description`/`format`/`body` are best-effort even when the entry is
 * invalid, so an author can open a broken template to repair it; `id` is `null` only when even a
 * shallow parse cannot recover it, which makes such an entry unaddressable by the by-id routes.
 */
export interface TemplateEntry {
  id: string | null;
  /** The file stem — the template's `name` and palette label, derived from the filename, not the bytes. */
  name: string;
  kind: TemplateKind;
  origin: TemplateOrigin;
  readOnly: boolean;
  absPath: string;
  bytes: Buffer;
  description: string;
  format: string | null;
  /** A step-template's `WorkflowNode[]` body. */
  body: unknown;
  valid: boolean;
  error: WireError["error"] | null;
}

export interface TemplateStore {
  /** Every discovered entry, in scan order: shipped before user, files sorted. */
  entries: TemplateEntry[];
  /**
   * `id → entry` for the by-id routes. First-seen wins — shipped is scanned before user, so a user
   * hand-copy of a shipped id resolves to the shipped entry. Malformed, id-less entries are absent.
   */
  byId: Map<string, TemplateEntry>;
}

/** The names of files directly under `dir` that end with `suffix`, sorted; `[]` when `dir` is absent. */
function templateFiles(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.sort();
}

/** The validity/identity facts of one step-template file's bytes. Never throws — malformed JSON is invalid. */
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
 * Discover the shipped∪user template union, fresh (no cache). Scans the two roots, types each file by
 * its suffix, validates its body registry-relative, and builds the `id → entry` index. A duplicate id
 * across origins invalidates the later (user) entry, never the earlier one and never the scan.
 */
export function discoverTemplates(
  projectDir: string,
  shippedDir: string,
  registry: StepPluginRegistry,
): TemplateStore {
  const stepSchema = makeStepTemplateSchema(registry);

  const roots: { root: string; origin: TemplateOrigin; readOnly: boolean }[] = [
    { root: shippedDir, origin: "shipped", readOnly: true },
    { root: userTemplateRoot(projectDir), origin: "user", readOnly: false },
  ];

  const entries: TemplateEntry[] = [];
  for (const { root, origin, readOnly } of roots) {
    for (const kind of ["step"] as const) {
      const suffix = SUFFIX[kind];
      const dir = join(root, KIND_DIR[kind]);
      for (const fileName of templateFiles(dir, suffix)) {
        const absPath = join(dir, fileName);
        const bytes = readFileSync(absPath);
        const name = fileName.slice(0, -suffix.length);
        entries.push({
          name,
          kind,
          origin,
          readOnly,
          absPath,
          bytes,
          ...classify(bytes, stepSchema),
        });
      }
    }
  }

  const byId = new Map<string, TemplateEntry>();
  for (const entry of entries) {
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

  return { entries, byId };
}

/** Whether `workflowPath` addresses a template, which the workflow doors refuse (§10.6): anything
 * lexically under `.path/template/`, resolved first so a `../` detour is caught too. */
export function isTemplatePath(projectDir: string, workflowPath: string): boolean {
  const relFromRoot = relative(projectDir, resolve(projectDir, workflowPath));
  const templateDir = join(".path", "template");
  return relFromRoot === templateDir || relFromRoot.startsWith(`${templateDir}${sep}`);
}

/** What the template doors read the store through: the project, its frozen registry, and the shipped root. */
export interface TemplateStoreContext {
  project: { dir: string };
  stepPlugins: StepPluginRegistry;
  shippedTemplateDir?: string;
}

/** The template union one server serves, scanned fresh for this request. */
export function templatesOf(ctx: TemplateStoreContext): TemplateStore {
  return discoverTemplates(resolve(ctx.project.dir), shippedTemplateDir(ctx), ctx.stepPlugins);
}

/**
 * The user template `id` names, for a door that changes one — or the refusal: unknown → `404`,
 * shipped → `403` (read-only, ADR 0050 decision 9).
 */
export function writableTemplate(
  store: TemplateStore,
  id: string,
): { ok: true; entry: TemplateEntry } | { ok: false; status: 404 | 403; message: string } {
  const entry = store.byId.get(id);
  if (entry === undefined) return { ok: false, status: 404, message: "not found" };
  if (entry.readOnly) return { ok: false, status: 403, message: "template is read-only" };
  return { ok: true, entry };
}

/** One entry as its thin wire row (§10.1): everything but the body. */
export function templateSummary(entry: TemplateEntry): TemplateSummary {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    origin: entry.origin,
    read_only: entry.readOnly,
    valid: entry.valid,
    error: entry.error,
  };
}
