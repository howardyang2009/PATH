import {
  type ChildSlot,
  CONTROL_CHILD_SLOTS,
  identityIssues,
  RESERVED_TYPE_NAMES,
  type StepPluginRegistry,
  safeParseWorkflowFile,
  type WireStepPlugin,
  type WorkflowFile,
} from "@path/schema";
import { z } from "zod";

/**
 * The Designer's open pipeline: raw on-disk text (`GET /v0/workflows/file`, kept raw so an id-less or
 * unknown-field file survives) plus the received step-plugin registry in, either a parsed
 * `WorkflowFile` or one of four legible refusals out. Pass order is deliberate — absent-type gate
 * (ADR 0026), then identity (ADR 0015), then the strict registry-relative schema parse.
 */

/** One step `type` the file names but the received registry does not describe. */
export interface AbsentStepType {
  type: string;
  /** The `packages/engine/plugin/step-plugin/<type>/` folder that would resolve it. */
  folder: string;
}

/** The outcome of opening a file: a rendered model, or one of the legible refusals. */
export type OpenResult =
  | { status: "opened"; file: WorkflowFile; idsStamped: boolean }
  | { status: "unregistered-types"; absent: AbsentStepType[]; message: string }
  | { status: "duplicate-ids"; message: string }
  | { status: "invalid-ids"; message: string }
  | { status: "invalid"; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

interface RawNodeRef {
  obj: Record<string, unknown>;
  path: (string | number)[];
}

/**
 * The child node objects of one raw node, descending by the one shape table `@path/schema` exposes
 * (`CONTROL_CHILD_SLOTS`). Runs before the schema parse (an id-less or unregistered-type file must
 * survive it), so it cannot take typed `WorkflowNode`s; a new control block lands in that table and is
 * scanned here automatically. A branch arm's occupant is unwrapped from its `{ when, node }` shape.
 */
function rawChildNodes(node: Record<string, unknown>, base: (string | number)[]): RawNodeRef[] {
  const type = typeof node.type === "string" ? node.type : "";
  const slots = (CONTROL_CHILD_SLOTS as Record<string, readonly ChildSlot[]>)[type];
  if (!slots) return [];
  const out: RawNodeRef[] = [];
  for (const slot of slots) {
    const raw = node[slot.key];
    if (slot.shape === "node-list") {
      (asArray(raw) ?? []).forEach((child, i) => {
        const obj = asObject(child);
        if (obj) out.push({ obj, path: [...base, slot.key, i] });
      });
    } else if (slot.shape === "arm-list") {
      (asArray(raw) ?? []).forEach((arm, i) => {
        const obj = asObject(asObject(arm)?.node);
        if (obj) out.push({ obj, path: [...base, slot.key, i, "node"] });
      });
    } else {
      const obj = asObject(raw);
      if (obj) out.push({ obj, path: [...base, slot.key] });
    }
  }
  return out;
}

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

function nodeLabel(ref: RawNodeRef): string {
  return typeof ref.obj.name === "string" ? `"${ref.obj.name}"` : `at ${ref.path.join(".")}`;
}

/** The aggregate refusal for a file naming types absent from the registry: every absent type, the folder
 * that resolves each, and the refresh-and-retry the stale-snapshot case needs. */
function unregisteredTypesMessage(absent: AbsentStepType[]): string {
  const lines = absent.map((a) => `  • "${a.type}" — add ${a.folder} to this PATH tree`);
  return [
    `Cannot open: this file names ${absent.length} step type${absent.length === 1 ? "" : "s"} absent from the server's registry.`,
    ...lines,
    "If the server has since loaded these plugins, refresh the registry and retry.",
  ].join("\n");
}

/**
 * Reconstruct a parse-time `StepPluginRegistry` from the wire snapshot: each registered leaf `type` by
 * name, its declared fields left open (`z.unknown()`), since the wire carries field descriptors, not
 * plugin zod schemas. Each field is `.optional()`: zod v4 no longer makes an `unknown` object key
 * implicitly optional, so without it a valid file omitting one (`binary` with no `args`) would not open.
 */
export function wireToRegistry(plugins: WireStepPlugin[]): StepPluginRegistry {
  const registry: StepPluginRegistry = {};
  for (const plugin of plugins) {
    const fields: Record<string, z.ZodTypeAny> = {};
    for (const fieldName of Object.keys(plugin.fields)) fields[fieldName] = z.unknown().optional();
    registry[plugin.name] = {
      fields,
      config: {},
      workers: Object.fromEntries(plugin.workers.map((name) => [name, null])),
      defaultWorker: plugin.default_worker,
    };
  }
  return registry;
}

function knownTypeNames(plugins: WireStepPlugin[]): Set<string> {
  return new Set<string>([...RESERVED_TYPE_NAMES, ...plugins.map((p) => p.name)]);
}

/**
 * The absent-type gate: one `AbsentStepType` per distinct absent type, in first-seen order. A
 * non-string `type` is left for the schema parse to reject — malformed, not merely unregistered.
 */
function findAbsentTypes(nodes: RawNodeRef[], plugins: WireStepPlugin[]): AbsentStepType[] {
  const known = knownTypeNames(plugins);
  const seen = new Set<string>();
  const absent: AbsentStepType[] = [];
  for (const { obj } of nodes) {
    const type = obj.type;
    if (typeof type === "string" && !known.has(type) && !seen.has(type)) {
      seen.add(type);
      absent.push({ type, folder: `packages/engine/plugin/step-plugin/${type}/` });
    }
  }
  return absent;
}

/**
 * Is a value a present (non-absent) `id`? A missing key is absent; `null`/a number/a non-UUID string is
 * present-but-invalid.
 */
function isPresent(id: unknown): boolean {
  return id !== undefined;
}

/**
 * The identity gate (ADR 0015), over the workflow's own `id` and every node's. `root` and `nodes` are
 * the same object graph `safeParseWorkflowFile` then reads, so a stamp lands in the parsed model. The
 * **rule** is `@path/schema`'s (`identityIssues`), the same one the load refinement and write route
 * apply; only the refusal's presentation — human node labels — is the Designer's.
 */
function resolveIdentity(
  root: Record<string, unknown>,
  nodes: RawNodeRef[],
): { status: "invalid-ids" | "duplicate-ids"; message: string } | { dirty: boolean } {
  const rootRef: RawNodeRef = { obj: root, path: ["(workflow)"] };
  const labelFor = (ref: RawNodeRef): string => (ref === rootRef ? "the workflow" : nodeLabel(ref));
  const all = [rootRef, ...nodes];
  // Paths are the caller's own spelling, so an issue path maps back to the ref whose label is printed.
  const refByPath = new Map(all.map((ref) => [JSON.stringify(ref.path), ref]));
  const labelAt = (path: (string | number)[]): string => {
    const ref = refByPath.get(JSON.stringify(path));
    return ref === undefined ? `at ${path.join(".")}` : labelFor(ref);
  };

  const issues = identityIssues(
    all.map((ref) => ({ id: ref.obj.id, path: ref.path })),
    ["invalid-id", "duplicate-id"],
  );

  // Present-but-invalid ids refuse: an author who hand-typed a non-UUID may be encoding meaning, which
  // the Designer must not clobber.
  const invalid = issues.filter((issue) => issue.rule === "invalid-id");
  if (invalid.length > 0) {
    const lines = invalid.map(
      (issue) =>
        `  • ${labelAt(issue.path)} has an id that is not a UUIDv4: ${JSON.stringify(issue.value)}`,
    );
    return {
      status: "invalid-ids",
      message: [
        `Cannot open: ${invalid.length} node id${invalid.length === 1 ? " is" : "s are"} not valid UUIDv4s.`,
        ...lines,
      ].join("\n"),
    };
  }

  // Duplicate ids refuse: silently re-minting one breaks resume (ADR 0015), so a human must choose which
  // node keeps the id. One bullet per repeated id, naming every node that shares it.
  const shared = new Map<unknown, (string | number)[][]>();
  for (const issue of issues.filter((candidate) => candidate.rule === "duplicate-id")) {
    const paths = shared.get(issue.value) ?? [];
    if (paths.length === 0 && issue.firstPath !== undefined) paths.push(issue.firstPath);
    paths.push(issue.path);
    shared.set(issue.value, paths);
  }
  if (shared.size > 0) {
    const lines = [...shared.entries()].map(
      ([id, paths]) => `  • id ${JSON.stringify(id)} is shared by ${paths.map(labelAt).join(", ")}`,
    );
    return {
      status: "duplicate-ids",
      message: [
        `Cannot open: ${shared.size} node id${shared.size === 1 ? " is" : "s are"} used more than once.`,
        ...lines,
      ].join("\n"),
    };
  }

  // Absent ids are stamped fresh. The buffer opens dirty: the Designer opened something the format did
  // not accept and is proposing the repair, un-persisted until a save (ADR 0015).
  let dirty = false;
  for (const ref of all) {
    if (!isPresent(ref.obj.id)) {
      ref.obj.id = crypto.randomUUID();
      dirty = true;
    }
  }
  return { dirty };
}

/** Open a raw workflow file against the received registry; see the module doc for the pass order. */
export function openWorkflowFile(rawText: string, plugins: WireStepPlugin[]): OpenResult {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (error) {
    return {
      status: "invalid",
      message: `Cannot open: the file is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
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
    return {
      status: "invalid",
      message: `Cannot open: the file does not validate.\n${parsed.errors.join("\n")}`,
    };
  }
  // `idsStamped` drives the open badge's wording, not the buffer's dirtiness: dirtiness is
  // content-equality against the baseline (ADR 0030), computed by the session because a stamp changed bytes.
  return { status: "opened", file: parsed.data, idsStamped };
}
