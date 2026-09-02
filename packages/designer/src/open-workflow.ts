import { z } from "zod";
import {
  IdSchema,
  RESERVED_TYPE_NAMES,
  safeParseWorkflowFile,
  type StepPluginRegistry,
  type WireStepPlugin,
  type WorkflowFile,
} from "@path/schema";

/**
 * Opening a workflow file into the read-only canvas model (#367, designer-spec § Canvas interaction
 * model, § Opening a file the palette cannot render). This is the Designer's **open pipeline**: it takes
 * the raw on-disk text (`GET /v0/workflows/file`, kept raw so an id-less or unknown-field file survives,
 * ADR 0015) and the received step-plugin registry (`GET /v0/step-plugins`), and returns either a parsed
 * `WorkflowFile` to render or one of four legible refusals.
 *
 * The order of the passes is deliberate. Portability first (ADR 0026): a file naming any step `type`
 * the received registry does not describe cannot be rendered at all, so it refuses before anything else,
 * naming **every** absent type and the folder that would resolve each. Then identity (ADR 0015): a
 * duplicate or invalid-format `id` refuses (a silent repair would either destroy resume history or
 * clobber an author's deliberate string), while a merely **absent** `id` is stamped fresh (`idsStamped`).
 * Only then does the strict registry-relative schema parse produce the typed model. The stamp itself does
 * not set a dirty flag: dirtiness is content-equality against the baseline (ADR 0030), and a stamp reads
 * dirty only because it changed bytes.
 *
 * Why not one strict `makeWorkflowFileSchema` pass end to end (ADR 0026's "one door"): the wire registry
 * carries field *descriptors*, not the plugin zod schemas, so the browser cannot rebuild the server's
 * strict leaf-field validation. For this read-only render that is moot — no plugin field value is drawn —
 * so the reconstructed registry admits each registered leaf `type` by name and leaves its fields open.
 * The absent-type and identity gates, which this ticket does own, run as their own explicit passes above.
 */

/** One step `type` the file names but the received registry does not describe (ADR 0026). */
export interface AbsentStepType {
  /** The unregistered `type` discriminant, echoed verbatim. */
  type: string;
  /** The `packages/engine/step-plugins/<type>/` folder that would resolve it — the engine's own remedy. */
  folder: string;
}

/** The outcome of opening a file: a rendered model, or one of the legible refusals. */
export type OpenResult =
  | { status: "opened"; file: WorkflowFile; idsStamped: boolean }
  | { status: "unregistered-types"; absent: AbsentStepType[]; message: string }
  | { status: "duplicate-ids"; message: string }
  | { status: "invalid-ids"; message: string }
  | { status: "invalid"; message: string };

/** A non-null, non-array object, or null. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An array, or null. */
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** One raw node found in the tree, with the JSON path that locates it for an error message. */
interface RawNodeRef {
  obj: Record<string, unknown>;
  path: (string | number)[];
}

/**
 * The child node objects of one raw node, following the block grammar's descent (`node-walk.ts`
 * `childBodies`, restated here over untyped JSON). Only the four block logicers nest children inline;
 * a leaf step, a `workflow` ref, and a `checkpoint` have none — and an **unregistered** type is always a
 * leaf (the six control names are reserved and always known), so nothing renderable is skipped. A branch
 * arm's occupant is unwrapped from its `{ when, node }` shape. Each child carries its own JSON path.
 */
function rawChildNodes(node: Record<string, unknown>, base: (string | number)[]): RawNodeRef[] {
  switch (node.type) {
    case "sequence":
      return (asArray(node.body) ?? []).flatMap((child, i) => {
        const obj = asObject(child);
        return obj ? [{ obj, path: [...base, "body", i] }] : [];
      });
    case "parallel":
      return (asArray(node.branches) ?? []).flatMap((child, i) => {
        const obj = asObject(child);
        return obj ? [{ obj, path: [...base, "branches", i] }] : [];
      });
    case "while-do": {
      const obj = asObject(node.node);
      return obj ? [{ obj, path: [...base, "node"] }] : [];
    }
    case "branch": {
      const out: RawNodeRef[] = [];
      (asArray(node.arms) ?? []).forEach((arm, i) => {
        const obj = asObject(asObject(arm)?.node);
        if (obj) out.push({ obj, path: [...base, "arms", i, "node"] });
      });
      const elseObj = asObject(node.else);
      if (elseObj) out.push({ obj: elseObj, path: [...base, "else"] });
      return out;
    }
    default:
      return [];
  }
}

/** Every node object in a file body, depth-first, each with its JSON path. */
function collectRawNodes(body: unknown[]): RawNodeRef[] {
  const out: RawNodeRef[] = [];
  const visit = (ref: RawNodeRef): void => {
    out.push(ref);
    for (const child of rawChildNodes(ref.obj, ref.path)) visit(child);
  };
  body.forEach((child, i) => {
    const obj = asObject(child);
    if (obj) visit({ obj, path: ["body", i] });
  });
  return out;
}

/** A human handle for a node in an error message: its `name` if it has a string one, else its JSON path. */
function nodeLabel(ref: RawNodeRef): string {
  return typeof ref.obj.name === "string" ? `"${ref.obj.name}"` : `at ${ref.path.join(".")}`;
}

/**
 * The aggregate refusal for a file naming step types absent from the registry (ADR 0026): every absent
 * type in one message, the folder that resolves each, and the refresh-and-retry the stale-snapshot case
 * needs. Mirrors the engine's own unknown-type remedy so the two read the same.
 */
function unregisteredTypesMessage(absent: AbsentStepType[]): string {
  const lines = absent.map((a) => `  • "${a.type}" — add ${a.folder} to this PATH tree`);
  return [
    `Cannot open: this file names ${absent.length} step type${absent.length === 1 ? "" : "s"} absent from the server's registry.`,
    ...lines,
    "If the server has since loaded these plugins, refresh the registry and retry.",
  ].join("\n");
}

/**
 * Reconstruct a parse-time `StepPluginRegistry` from the wire snapshot. It admits each registered leaf
 * `type` by name — so the strict node union rejects any *other* type — but leaves each type's fields
 * open (`z.unknown()` per declared field name). The wire carries field descriptors, not the plugin zod
 * schemas, and this read-only render draws no plugin field value, so field-level validation is neither
 * possible nor needed here; the `.strict()` member still rejects an unknown field key and an unknown
 * worker name. `config` is left empty (passthrough via the member factory).
 */
export function wireToRegistry(plugins: WireStepPlugin[]): StepPluginRegistry {
  const registry: StepPluginRegistry = {};
  for (const plugin of plugins) {
    const fields: Record<string, z.ZodTypeAny> = {};
    for (const fieldName of Object.keys(plugin.fields)) fields[fieldName] = z.unknown();
    registry[plugin.name] = {
      fields,
      config: {},
      workers: Object.fromEntries(plugin.workers.map((name) => [name, null])),
      defaultWorker: plugin.default_worker,
    };
  }
  return registry;
}

/** The known type names for a registry: the six reserved control names plus every registered leaf type. */
function knownTypeNames(plugins: WireStepPlugin[]): Set<string> {
  return new Set<string>([...RESERVED_TYPE_NAMES, ...plugins.map((p) => p.name)]);
}

/**
 * The absent-type gate (ADR 0026). Scans every node's `type` against the known set and returns one
 * `AbsentStepType` per distinct absent type, in first-seen order. A non-string `type` is left for the
 * schema parse to reject — it is malformed, not merely unregistered.
 */
function findAbsentTypes(nodes: RawNodeRef[], plugins: WireStepPlugin[]): AbsentStepType[] {
  const known = knownTypeNames(plugins);
  const seen = new Set<string>();
  const absent: AbsentStepType[] = [];
  for (const { obj } of nodes) {
    const type = obj.type;
    if (typeof type === "string" && !known.has(type) && !seen.has(type)) {
      seen.add(type);
      absent.push({ type, folder: `packages/engine/step-plugins/${type}/` });
    }
  }
  return absent;
}

/** Is a value a present (non-absent) `id`? A missing key is absent; `null`/a number/a non-UUID string is present-but-invalid. */
function isPresent(id: unknown): boolean {
  return id !== undefined;
}

/** A present `id` that is a valid UUIDv4 (via the schema's own `IdSchema`, so the shape never drifts from the loader's). */
function isValidId(id: unknown): boolean {
  return IdSchema.safeParse(id).success;
}

/**
 * The identity gate (ADR 0015), over the workflow's own `id` and every node's. A present-but-invalid
 * `id` or a duplicate refuses the open, naming the offenders; a merely absent `id` is stamped fresh and
 * flips the buffer dirty. `root` and `nodes` are the same object graph `safeParseWorkflowFile` then
 * reads, so a stamp lands in the parsed model. Returns a refusal, or `{ dirty }` for a clean/repaired file.
 */
function resolveIdentity(
  root: Record<string, unknown>,
  nodes: RawNodeRef[],
): { status: "invalid-ids" | "duplicate-ids"; message: string } | { dirty: boolean } {
  const rootRef: RawNodeRef = { obj: root, path: ["(workflow)"] };
  const labelFor = (ref: RawNodeRef): string => (ref === rootRef ? "the workflow" : nodeLabel(ref));
  const all = [rootRef, ...nodes];

  // Present-but-invalid ids refuse — an author who hand-typed a non-UUID may be encoding meaning, which
  // the Designer must not clobber. Aggregate, so one open names every offender.
  const invalid = all.filter((ref) => isPresent(ref.obj.id) && !isValidId(ref.obj.id));
  if (invalid.length > 0) {
    const lines = invalid.map((ref) => `  • ${labelFor(ref)} has an id that is not a UUIDv4: ${JSON.stringify(ref.obj.id)}`);
    return {
      status: "invalid-ids",
      message: [`Cannot open: ${invalid.length} node id${invalid.length === 1 ? " is" : "s are"} not valid UUIDv4s.`, ...lines].join("\n"),
    };
  }

  // Duplicate ids refuse — silently re-minting one is exactly the resume-breaking mutation ADR 0015
  // exists to prevent; a human must choose which node keeps the id.
  const byId = new Map<string, RawNodeRef[]>();
  for (const ref of all) {
    if (!isPresent(ref.obj.id)) continue;
    const id = ref.obj.id as string;
    const group = byId.get(id) ?? [];
    group.push(ref);
    byId.set(id, group);
  }
  const collisions = [...byId.entries()].filter(([, refs]) => refs.length > 1);
  if (collisions.length > 0) {
    const lines = collisions.map(([id, refs]) => `  • id ${JSON.stringify(id)} is shared by ${refs.map(labelFor).join(", ")}`);
    return {
      status: "duplicate-ids",
      message: [`Cannot open: ${collisions.length} node id${collisions.length === 1 ? " is" : "s are"} used more than once.`, ...lines].join("\n"),
    };
  }

  // Absent ids are stamped fresh into the object graph. The buffer opens dirty: the Designer opened
  // something the format did not accept and is proposing the repair, un-persisted until a save (ADR 0015).
  let dirty = false;
  for (const ref of all) {
    if (!isPresent(ref.obj.id)) {
      ref.obj.id = crypto.randomUUID();
      dirty = true;
    }
  }
  return { dirty };
}

/**
 * Open a raw workflow file against the received registry. See the module doc for the pass order:
 * JSON parse, absent-type gate (ADR 0026), identity gate (ADR 0015), then the strict registry-relative
 * schema parse for the typed model.
 */
export function openWorkflowFile(rawText: string, plugins: WireStepPlugin[]): OpenResult {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (error) {
    return { status: "invalid", message: `Cannot open: the file is not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
  }

  const root = asObject(json);
  const body = root ? asArray(root.body) : null;
  const nodes = body ? collectRawNodes(body) : [];

  const absent = findAbsentTypes(nodes, plugins);
  if (absent.length > 0) {
    return { status: "unregistered-types", absent, message: unregisteredTypesMessage(absent) };
  }

  let idsStamped = false;
  if (root) {
    const identity = resolveIdentity(root, nodes);
    if ("status" in identity) return identity;
    idsStamped = identity.dirty;
  }

  const parsed = safeParseWorkflowFile(json, wireToRegistry(plugins));
  if (!parsed.success) {
    return { status: "invalid", message: `Cannot open: the file does not validate.\n${parsed.errors.join("\n")}` };
  }
  // `idsStamped` records only that the identity gate minted an absent `id`; it drives the open badge's
  // wording, not the buffer's dirtiness. Dirtiness is content-equality against the baseline (ADR 0030):
  // a stamp reads dirty because it changed bytes, computed by the session, not asserted here.
  return { status: "opened", file: parsed.data, idsStamped };
}
