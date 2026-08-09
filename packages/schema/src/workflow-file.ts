import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { childBodies, walkNodes } from "./node-walk.js";
import { NodeArraySchema } from "./nodes.js";
import { STEP_ROOTS } from "./roots.js";
import { WorkerSchema } from "./worker.js";
import { FORMAT_VERSION, LEGACY_FORMAT_VERSION, type WorkflowFile } from "./workflow-file-type.js";
import type { WorkflowNode } from "./node-type.js";

export { FORMAT_VERSION };

const BaseWorkflowFileSchema = z
  .object({
    format: z.literal(FORMAT_VERSION),
    id: IdSchema,
    name: NameSchema,
    worker: WorkerSchema,
    config: ConfigObjectSchema.optional(),
    body: NodeArraySchema,
    output: z.record(interpolatedJsonValue(STEP_ROOTS)).optional(),
  })
  .strict();

interface NameOccurrence {
  name: string;
  path: (string | number)[];
}

// Every body node (steps, blocks, checkpoints) and every parallel branch carries a required human
// `name`, unique across the whole file at every nesting level (workflow-format-v0.md §3). The GUID
// `id` beside it is unique by construction, so only `name` is checked here.
function collectNames(nodes: WorkflowNode[], basePath: (string | number)[]): NameOccurrence[] {
  const found: NameOccurrence[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];
    found.push({ name: node.name, path: [...nodePath, "name"] });

    for (const child of childBodies(node)) {
      // A parallel branch's own name is not a node's, and is unique on the same terms.
      if (child.branchName !== undefined) {
        found.push({ name: child.branchName, path: [...nodePath, ...child.path.slice(0, -1), "name"] });
      }
      found.push(...collectNames(child.nodes, [...nodePath, ...child.path]));
    }
  });

  return found;
}

// Publish keys are static strings, so a race between sibling parallel branches writing the same
// context key is detectable — and rejected — at load time (workflow-format-v0.md §10). Walks nested
// control blocks but not into a `workflow` step's ref'd file: that file has its own isolated
// context (childBodies does not descend there).
function collectPublishKeys(nodes: WorkflowNode[]): string[] {
  const keys: string[] = [];
  for (const node of walkNodes(nodes)) {
    if ((node.type === "prompt" || node.type === "binary" || node.type === "workflow") && node.publish) {
      keys.push(...Object.keys(node.publish));
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
            collisions.push({ key, path: [...nodePath, ...child.path.slice(0, -1)] });
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

export const WorkflowFileSchema: z.ZodType<WorkflowFile> = BaseWorkflowFileSchema.superRefine((file, ctx) => {
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
});

export interface WorkflowFileParseSuccess {
  success: true;
  data: WorkflowFile;
}

export interface WorkflowFileParseFailure {
  success: false;
  errors: string[];
}

// A pre-migration file carrying the old `format` string gets a targeted error naming the codemod,
// not a generic zod "invalid literal": the shape changed (GUID `id` + human `name` — ADR 0007), so
// the fix is to migrate, not to hand-edit `format`.
function legacyFormatError(json: unknown): WorkflowFileParseFailure | null {
  if (
    typeof json === "object" &&
    json !== null &&
    (json as { format?: unknown }).format === LEGACY_FORMAT_VERSION
  ) {
    return {
      success: false,
      errors: [
        `format "${LEGACY_FORMAT_VERSION}" predates the identity migration (durable GUID \`id\` + human ` +
          `\`name\` — ADR 0006/0007). Run the workflow-format codemod to migrate this file to "${FORMAT_VERSION}".`,
      ],
    };
  }
  return null;
}

export function safeParseWorkflowFile(
  json: unknown,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  const legacy = legacyFormatError(json);
  if (legacy) return legacy;
  const result = WorkflowFileSchema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatIssues(result.error) };
}

export function parseWorkflowFile(json: unknown): WorkflowFile {
  const result = safeParseWorkflowFile(json);
  if (!result.success) {
    throw new Error(`invalid workflow file:\n${result.errors.join("\n")}`);
  }
  return result.data;
}
