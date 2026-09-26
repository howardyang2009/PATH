import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStepTemplateSchema, safeParseStepTemplateWith, type StepPluginRegistry, type WireError } from "@path/schema";

// The Template store (ADR 0050, ADR 0051): the Server-owned, engine-blind discovery of the
// shipped∪user authoring templates. A template is typed by its file **suffix**, never its bytes
// (ADR 0050 decision 2), so the two maps below are the whole classification: kind → its `<kind-dir>`
// and its file suffix. A `<name>.<suffix>` in `<root>/<kind-dir>/` is a template of that kind. The
// Step-Template is the only kind (ADR 0063 removed the Workflow-Template).

export type TemplateKind = "step";
export type TemplateOrigin = "shipped" | "user";

/** kind → the file suffix that names it. */
const SUFFIX: Record<TemplateKind, string> = {
  step: ".step-template.json",
};

/** kind → the subdirectory it lives under, in both roots. */
const KIND_DIR: Record<TemplateKind, string> = {
  step: "step-template",
};

export function suffixFor(kind: TemplateKind): string {
  return SUFFIX[kind];
}

export function kindDirFor(kind: TemplateKind): string {
  return KIND_DIR[kind];
}

/**
 * The `.path/template/<kind-dir>/` root under a project, where every **user** (writable) template
 * lives. The union is this `<kind-dir>` plus the shipped one.
 */
export function userTemplateRoot(projectDir: string): string {
  return join(projectDir, ".path", "template");
}

/**
 * The shipped (read-only) template root: `packages/server/template`, resolved relative to this
 * package. Absent until fixtures ship — the scan of a missing directory is an empty contribution,
 * never a Server-start failure (ADR 0050 decision 3). A caller (a test) may inject a different root.
 */
export const DEFAULT_SHIPPED_TEMPLATE_DIR = fileURLToPath(new URL("../template", import.meta.url));

/**
 * The shipped template root the union scans: a context override (a test's fixture root) or the
 * package-relative default. One place, so the template routes cannot disagree about where shipped
 * templates live.
 */
export function shippedTemplateDir(ctx: { shippedTemplateDir?: string }): string {
  return ctx.shippedTemplateDir ?? DEFAULT_SHIPPED_TEMPLATE_DIR;
}

/**
 * One discovered template. `id`/`description`/`format`/`body` are best-effort even when the entry is
 * invalid, so an author can open a broken template to repair it (ADR 0050 decision 5); `id` is `null`
 * only when even a shallow parse cannot recover it (malformed JSON), and such an entry is unaddressable
 * by the by-id routes. `bytes` is the exact on-disk source the byte-exact ETag hashes.
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
   * `id → entry` for the by-id routes. First-seen wins — a shipped file is scanned before a user one,
   * so a user hand-copy of a shipped id resolves to the shipped entry and the user duplicate lists
   * `valid: false` (ADR 0050 decision 3). Malformed, id-less entries are absent (unaddressable).
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

  // A step-template's palette blurb is its required envelope `description`.
  const description = typeof obj.description === "string" ? obj.description : "";
  const body = obj.body ?? null;

  const parsed = safeParseStepTemplateWith(stepSchema, raw);
  const error = parsed.success
    ? null
    : { message: parsed.errors[0] ?? "invalid template", details: parsed.errors };

  return { id, description, format, body, valid: parsed.success, error };
}

/**
 * Discover the shipped∪user template union, fresh (no cache, like `GET /v0/workflows`). Scans the two
 * directories — `<shippedDir>/step-template/` (read-only) and `<projectDir>/.path/template/step-template/`
 * (writable) — types each file by its
 * suffix, validates its body registry-relative, and builds the `id → entry` index the by-id routes
 * resolve against. A duplicate id across origins invalidates the later (user) entry, never the earlier
 * one and never the scan (ADR 0050 decision 3).
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
      // A second file claiming a live id (a user hand-copy of a shipped file): the earlier entry keeps
      // the id, this one is flagged invalid (ADR 0050 decision 3). Both still list.
      entry.valid = false;
      entry.error = {
        message: `duplicate id "${entry.id}": already used by ${existing.origin} template "${existing.name}"`,
      };
    }
  }

  return { entries, byId };
}
