import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { childBodies, walkNodes } from "./node-walk.js";
import { makeNodeSchema, type StepPluginRegistry } from "./nodes.js";
import { STEP_ROOTS } from "./roots.js";
import { FORMAT_VERSION, SUPERSEDED_FORMAT_VERSIONS, type WorkflowFile } from "./workflow-file-type.js";
import type { WorkflowNode } from "./node-type.js";

export { FORMAT_VERSION };

// The file envelope, parameterised by its `body` schema so the plugin factory can wrap the opened
// node union `makeNodeSchema(registry)` builds. Everything except `body` is fixed grammar. There is no
// closed built-in envelope any more — a file is only ever parsed against a registry (ADR 0019, #337).
function buildBaseWorkflowFileSchema(bodySchema: z.ZodType<WorkflowNode[]>) {
  return z
    .object({
      format: z.literal(FORMAT_VERSION),
      id: IdSchema,
      name: NameSchema,
      config: ConfigObjectSchema.optional(),
      body: bodySchema,
      output: z.record(interpolatedJsonValue(STEP_ROOTS)).optional(),
    })
    .strict();
}

interface NameOccurrence {
  name: string;
  path: (string | number)[];
}

// Every node — steps, logicers, checkpoints, and each `parallel` branch (now itself a node, `@2`
// §4.3) — carries a required human `name`, unique across the whole file at every nesting level
// (workflow-format-v2.md §3). The GUID `id` beside it is unique by construction, so only `name` is
// checked here. Branch nodes are reached by ordinary recursion: `childBodies` exposes each branch as
// a one-node slot, so its `name` is collected like any other node's.
function collectNames(nodes: WorkflowNode[], basePath: (string | number)[]): NameOccurrence[] {
  const found: NameOccurrence[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];
    found.push({ name: node.name, path: [...nodePath, "name"] });

    for (const child of childBodies(node)) {
      found.push(...collectNames(child.nodes, [...nodePath, ...child.path]));
    }
  });

  return found;
}

// The `publish` map of any node that carries one — the three built-in publishing step types and
// every plugin leaf step (all draw `publish` from `commonStepFields`). Detected by presence, not a
// built-in-type allowlist, so a plugin step's publishes fall under the same race / do-not-wait guards
// once the open union admits them (ADR 0018). Control nodes never carry `publish`, so widening from
// the allowlist to presence changes nothing for the closed union.
function nodePublish(node: WorkflowNode): Record<string, unknown> | undefined {
  const publish = (node as { publish?: unknown }).publish;
  return publish !== null && typeof publish === "object" ? (publish as Record<string, unknown>) : undefined;
}

// Publish keys are static strings, so a race between sibling parallel branches writing the same
// context key is detectable — and rejected — at load time (workflow-format-v0.md §10). Walks nested
// control blocks but not into a `workflow` step's ref'd file: that file has its own isolated
// context (childBodies does not descend there).
function collectPublishKeys(nodes: WorkflowNode[]): string[] {
  const keys: string[] = [];
  for (const node of walkNodes(nodes)) {
    const publish = nodePublish(node);
    if (publish) {
      keys.push(...Object.keys(publish));
    }
  }
  return keys;
}

interface PublishKeyCollision {
  key: string;
  path: (string | number)[];
}

function findDuplicatePublishKeys(nodes: WorkflowNode[], basePath: (string | number)[]): PublishKeyCollision[] {
  const collisions: PublishKeyCollision[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];

    // A `wait-one` parallel lands only the winner's publishes, so two branches publishing the same
    // key is deterministic — and is the headline race-two-sources pattern (wait-one-join.md §4.1).
    // The same-key ban is correct only for `collect`, where all branches land and two writes to one
    // key would be a last-writer race. Recursion still descends into a wait-one block's branches.
    const collisionsAllowed = node.type === "parallel" && node.join === "wait-one";

    // Only *concurrent* siblings can race. Branch arms are alternatives (one runs) and while-do
    // iterations are sequential, so neither collides with itself — `concurrent` is the rule.
    const firstSeenIn = new Map<string, number>();
    childBodies(node).forEach((child, childIndex) => {
      if (child.concurrent && !collisionsAllowed) {
        for (const key of new Set(collectPublishKeys(child.nodes))) {
          if (firstSeenIn.has(key)) {
            // `child.path` already lands on the branch node itself (`["branches", i]`, `@2` §4.3),
            // so the collision points at the offending branch directly — no trailing segment to trim.
            collisions.push({ key, path: [...nodePath, ...child.path] });
          } else {
            firstSeenIn.set(key, childIndex);
          }
        }
      }
      collisions.push(...findDuplicatePublishKeys(child.nodes, [...nodePath, ...child.path]));
    });
  });

  return collisions;
}

interface DoNotWaitPublish {
  key: string;
  path: (string | number)[];
}

// A `do-not-wait` branch is fire-and-forget: it runs past the join and lands after its would-be
// readers, so a `publish` from it is a nondeterministic write-after-read into shared context. It is a
// load error, not a silent runtime drop (do-not-wait-join.md §4). This is a separate check from
// `findDuplicatePublishKeys`, whose join-aware racing-branch collision logic is unchanged. `insideDoNotWait`
// latches on once a `do-not-wait` block is entered, so a publish anywhere below it — including one nested
// in a `collect`/`while-do`/`branch` inside the detached branch — is caught (§4 "anywhere inside").
function findDoNotWaitPublishes(
  nodes: WorkflowNode[],
  basePath: (string | number)[],
  insideDoNotWait: boolean,
): DoNotWaitPublish[] {
  const violations: DoNotWaitPublish[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];

    const publish = insideDoNotWait ? nodePublish(node) : undefined;
    if (publish) {
      for (const key of Object.keys(publish)) {
        violations.push({ key, path: [...nodePath, "publish", key] });
      }
    }

    const detached = insideDoNotWait || (node.type === "parallel" && node.join === "do-not-wait");
    for (const child of childBodies(node)) {
      violations.push(...findDoNotWaitPublishes(child.nodes, [...nodePath, ...child.path], detached));
    }
  });

  return violations;
}

// The cross-node invariants zod's per-field parse cannot express: file-unique names, no two
// concurrent parallel branches publishing one key, and no publish inside a `do-not-wait` branch.
// Applied by the plugin factory's schema (`makeWorkflowFileSchema`) over its open node set.
function checkWorkflowFileInvariants(file: WorkflowFile, ctx: z.RefinementCtx): void {
  const occurrences = collectNames(file.body, ["body"]);
  const byName = new Map<string, NameOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = byName.get(occurrence.name) ?? [];
    list.push(occurrence);
    byName.set(occurrence.name, list);
  }

  for (const [name, list] of byName) {
    if (list.length <= 1) continue;
    for (const occurrence of list.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: occurrence.path,
        message: `duplicate name "${name}": names must be unique across the whole file`,
      });
    }
  }

  for (const collision of findDuplicatePublishKeys(file.body, ["body"])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: collision.path,
      message: `duplicate publish key "${collision.key}": sibling parallel branches must not publish the same context key`,
    });
  }

  for (const violation of findDoNotWaitPublishes(file.body, ["body"], false)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: violation.path,
      message: `publish "${violation.key}" inside a do-not-wait branch: a fire-and-forget branch runs past the join and may not publish (do-not-wait-join.md §4)`,
    });
  }
}

/**
 * The whole `WorkflowFileSchema` for a given registry (ADR 0018 sub-decision 7): the file envelope
 * wrapping the open node union `makeNodeSchema(registry)` builds, plus the same cross-node invariants
 * the closed schema enforces. The registry is required and has no default — a caller with no plugins
 * still passes an empty registry, which describes a grammar with the six control members and no leaf
 * step. Build this once per freeze and parse many files with `safeParseWorkflowFileWith`.
 */
export function makeWorkflowFileSchema(registry: StepPluginRegistry): z.ZodType<WorkflowFile> {
  const nodeSchema = makeNodeSchema(registry);
  const bodySchema = z.array(nodeSchema).min(1) as unknown as z.ZodType<WorkflowNode[]>;
  return buildBaseWorkflowFileSchema(bodySchema).superRefine(checkWorkflowFileInvariants) as z.ZodType<WorkflowFile>;
}

export interface WorkflowFileParseSuccess {
  success: true;
  data: WorkflowFile;
}

export interface WorkflowFileParseFailure {
  success: false;
  errors: string[];
}

// A pre-migration file carrying a superseded `format` string gets a targeted error naming the
// codemod, not a generic zod "invalid literal": the shape changed (`@2`'s worker union, `@1`'s
// uniform single-node containers, `@0`'s GUID identity), so the fix is to migrate, not to hand-edit
// `format` (workflow-format-v3.md §1). The engine reads `@3` only — there is no dual reader.
function supersededFormatError(json: unknown): WorkflowFileParseFailure | null {
  if (typeof json !== "object" || json === null) return null;
  const format = (json as { format?: unknown }).format;
  if (typeof format !== "string" || !(format in SUPERSEDED_FORMAT_VERSIONS)) return null;
  // Per workflow-format-v2.md §1 (the ADR 0007 precedent): names the codemod script, never a generic
  // zod "invalid literal" on `format`. Each older string names its whole codemod chain in the order
  // the scripts must run, because a single codemod migrates one step only and would not move a file
  // that is two or three versions behind.
  const codemods = SUPERSEDED_FORMAT_VERSIONS[format as keyof typeof SUPERSEDED_FORMAT_VERSIONS];
  return {
    success: false,
    errors: [
      `${format} is no longer read — run ${codemods.join(" then ")} to migrate this file to ${FORMAT_VERSION}`,
    ],
  };
}

// The superseded-format pre-check and the success/failure shaping both doors share: parse a file
// against an already-built schema. `loadWorkflowTree` builds the schema once per registry freeze and
// calls this per file in the ref tree (ADR 0018 sub-decision 7).
export function safeParseWorkflowFileWith(
  schema: z.ZodType<WorkflowFile>,
  json: unknown,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  const superseded = supersededFormatError(json);
  if (superseded) return superseded;
  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatIssues(result.error) };
}

// The single-file convenience door: build the open schema for `registry` and parse `json` against it.
// The registry is **required** — there is no closed built-in schema to fall back on (ADR 0019, #337),
// so a caller with no plugins still passes an empty registry (a grammar of the six control members and
// no leaf step). A caller parsing many files should build the schema once with `makeWorkflowFileSchema`
// and reuse it via `safeParseWorkflowFileWith`; this door is for the one-off case.
export function safeParseWorkflowFile(
  json: unknown,
  registry: StepPluginRegistry,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  return safeParseWorkflowFileWith(makeWorkflowFileSchema(registry), json);
}

export function parseWorkflowFile(json: unknown, registry: StepPluginRegistry): WorkflowFile {
  const result = safeParseWorkflowFile(json, registry);
  if (!result.success) {
    throw new Error(`invalid workflow file:\n${result.errors.join("\n")}`);
  }
  return result.data;
}
